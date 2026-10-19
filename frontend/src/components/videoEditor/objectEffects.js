/*
 * OBJECT EFFECTS — the geometric-art family, as ordinary Overlay Effects.
 *
 * Reference: https://geometric-art.com/ ("GEOMETRIC: Image + Motion Art Studio"),
 * decoded in PLANS/OBJECT_EFFECTS_PLAN.md and prototyped in
 * html/object-effects-lab.html. Tune the look THERE first.
 *
 * WHERE THIS LANDS, AND WHY IT IS NOT ITS OWN SECTION
 * ---------------------------------------------------
 * The plan proposed a third inspector section beside LAYER EFFECTS and DEPTH
 * EFFECTS, on the depth pack's argument: a family with a prerequisite needs a
 * panel that can express the prerequisite. That argument dies the moment the scan
 * stops being shared — and it stops being shared here, because each effect wants
 * a different scan (see objectTracking.js). With the scan on the entry, every one
 * of these is an ordinary Overlay Effect: a stackable, windowable, keyframable,
 * layer-scoped GPU pass whose card happens to lead with a TRACKING block.
 *
 * That buys the whole registration for free — the Overlay chain's sanitizer is
 * descriptor-generic, the panel is descriptor-generic, Active Range and the mute
 * dot and the keyframe stopwatch all already work — which is the opposite of the
 * seven-gate ladder a typed Layer Effect has to climb.
 *
 * TWO FAMILIES, AND ONLY ONE OF THEM IS HERE
 * ------------------------------------------
 * The reference's programs split in two. The PIXEL programs (this file) are
 * per-fragment functions of the plate and the weight field — ordinary fragment
 * bodies with a TSL twin. The GEOMETRY programs (Node Field, Link Graph, Circle
 * Chain…) draw thousands of independent strokes over a Delaunay graph and are not
 * a shader at all; they need the Canvas2D → CanvasTexture chassis Mockup Frame
 * already owns, and they are deliberately NOT in this first drop.
 *
 * PARAM SLOTS. Slots 18–27 are the TRACK BLOCK (objectTracking.js writes the
 * field flags and the two boxes there). Every param below therefore claims a slot
 * in 0–17, and a new one must too.
 *
 * COST WHEN UNUSED. Zero. The descriptors are data; the field texture is built
 * only for a LIVE entry of a `usesTrack` effect (Player.resolveTrackFor), and the
 * scan worker is constructed on the first click of Scan subject and terminated
 * when it goes idle — a project with no Object effect loads no model, no worker
 * and no texture.
 */

import { TRACK_PRELUDE } from './objectTracking';

/*
 * Shared body prelude for the family: the ordered-dither lattices, the local
 * auto-level, and the region gate every program exposes as Apply to.
 *
 * AUTO-LEVEL — a deliberate, measured deviation from the lab. The lab found that
 * without a level stage Threshold means something different on every image (a dark
 * frame prints almost pure paper at 50%), and it fixed that with a GLOBAL 2nd/98th
 * percentile stretch. A percentile is a reduction, and a reduction is not a
 * fragment: doing it properly would cost this family a pyramid pass and a readback
 * on every frame of video. The stretch here is LOCAL instead — the fragment's own
 * neighbourhood mean over a wide cross — which solves the same problem (threshold
 * now means the same thing on any image) and, being local, also holds up inside a
 * frame that is half sky and half shadow, which the global stretch does not.
 */
const OBJ_PRELUDE = /* glsl */ `
${TRACK_PRELUDE}

// Straight (unpremultiplied) luminance of the plate at a LAYER-space point.
float objLum(vec2 p) {
  vec2 f = fxFrame(p);
  if (f.x < 0.0 || f.x > 1.0 || f.y < 0.0 || f.y > 1.0) return 0.0;
  vec4 s = texture2D(uTexture, f);
  return luma(unpremult(s)) * step(0.004, s.a);
}

// Recursive ordered-dither lattices. bayer2 is the 2×2 base; 4×4 and 8×8 fold it
// into itself, which is the standard construction and ports to TSL unchanged.
float objBayer2(vec2 a) { a = floor(a); return fract(a.x * 0.5 + a.y * a.y * 0.75); }
float objBayer4(vec2 a) { return objBayer2(a * 0.5) * 0.25 + objBayer2(a); }
float objBayer8(vec2 a) { return objBayer4(a * 0.5) * 0.25 + objBayer2(a); }

// Local auto-level: stretch this point's luminance against its own neighbourhood,
// then apply contrast about mid grey. spread is in layer-uv.
float objLevel(vec2 p, float l, float spread, float contrast, float on) {
  if (on < 0.5) return clamp(0.5 + (l - 0.5) * contrast, 0.0, 1.0);
  float m = 0.0;
  m += objLum(p + vec2( spread, 0.0));
  m += objLum(p + vec2(-spread, 0.0));
  m += objLum(p + vec2(0.0,  spread));
  m += objLum(p + vec2(0.0, -spread));
  m += objLum(p + vec2( spread,  spread) * 0.7);
  m += objLum(p + vec2(-spread, -spread) * 0.7);
  m += objLum(p + vec2( spread, -spread) * 0.7);
  m += objLum(p + vec2(-spread,  spread) * 0.7);
  m /= 8.0;
  // 0.42 is the half-span the stretch normalises against — wide enough that a
  // flat area does not explode into noise, tight enough that a low-contrast
  // frame still reaches both ends of the ramp.
  float n = clamp(0.5 + (l - m) / 0.84, 0.0, 1.0);
  return clamp(0.5 + (n - 0.5) * contrast, 0.0, 1.0);
}

// Edge strength at a layer-space point (Sobel-ish 4-tap), the "edge preserve"
// term: contours survive the threshold even where the tone does not.
float objEdge(vec2 p, float e) {
  float gx = objLum(p + vec2(e, 0.0)) - objLum(p - vec2(e, 0.0));
  float gy = objLum(p + vec2(0.0, e)) - objLum(p - vec2(0.0, e));
  return sqrt(gx * gx + gy * gy);
}

/*
 * The region gate — "Apply to": whole frame / subject / background. soft is the
 * falloff in weight units, so a feathered field ramps instead of cutting.
 * The no-scan field is flat 1.0, which makes Subject = everything and Background =
 * nothing; that is the honest answer, and the panel says to scan.
 */
float objRegion(vec2 p, float mode, float soft) {
  if (mode < 0.5) return 1.0;
  float w = trkFieldAt(p);
  float s = max(soft, 0.01);
  float inSubject = smoothstep(0.5 - s, 0.5 + s, w);
  return mode < 1.5 ? inSubject : 1.0 - inSubject;
}
`;

const REGION_PARAMS = (slotMode, slotSoft) => ([
  {
    key: 'region',
    slot: slotMode,
    label: 'Apply to',
    type: 'select',
    default: 0,
    track: true,
    options: [
      { value: 0, label: 'Whole layer' },
      { value: 1, label: 'Subject only' },
      { value: 2, label: 'Background only' },
    ],
  },
  {
    key: 'regionSoft',
    slot: slotSoft,
    label: 'Region falloff',
    min: 0,
    max: 100,
    step: 1,
    default: 30,
    suffix: '%',
    track: true,
    showIf: { key: 'region', oneOf: [1, 2] },
  },
]);

/* The TRACKING block's own controls. Identical on every Object effect, and
   deliberately per-EFFECT: two cards on one layer can scan different things.
   `scanOpt: true` marks the ones the scan itself consumes — changing one of those
   means the stored track is stale, which is what the panel's re-scan hint reads. */
const TRACK_PARAMS = (overrides = {}) => ([
  {
    key: 'trackSource',
    slot: null,
    label: 'Detect',
    type: 'select',
    default: 0,
    track: true,
    scanOpt: true,
    static: true,
    options: [
      { value: 0, label: 'Person silhouette' },
      { value: 1, label: 'Face' },
      { value: 2, label: 'Person + face' },
    ],
  },
  {
    key: 'trackFeather',
    slot: null,
    label: 'Field feather',
    min: 0,
    max: 8,
    step: 1,
    default: 2,
    suffix: ' cells',
    track: true,
    scanOpt: true,
    static: true,
  },
  {
    key: 'trackFaceBoost',
    slot: null,
    label: 'Face weight',
    min: 0,
    max: 100,
    step: 1,
    default: 100,
    suffix: '%',
    track: true,
    scanOpt: true,
    static: true,
  },
].map(p => (p.key in overrides ? { ...p, default: overrides[p.key] } : p)));

/* ── 08B · DITHER PRINT ───────────────────────────────────────────────────── */

const DITHER_FX = /* glsl */ `
${OBJ_PRELUDE}

vec4 fx(vec2 uv) {
  vec4 src = texture2D(uTexture, uv);
  vec2 lp = fxLocal(uv);
  vec2 res = fxRes();
  // Authored at the 1080px reference height, like every other pitch in the app,
  // so the print has the same cell count at preview and export resolution.
  float pitchPx = max(1.0, uParams[0] * (res.y / 1080.0));
  vec2 cellUv = vec2(pitchPx) / max(res, vec2(1.0));

  // Subject detail subdivides the CELL by an integer, so the fine lattice nests
  // exactly inside the coarse one and no seam can appear at the silhouette.
  vec2 coarse = floor(lp / cellUv);
  vec2 coarseCentre = (coarse + 0.5) * cellUv;
  float wCell = trkFieldAt(coarseCentre);
  float sub = floor(1.0 + (uParams[7] / 100.0) * 3.0 * wCell + 0.5);
  vec2 fine = cellUv / sub;
  vec2 cell = floor(lp / fine);
  vec2 centre = (cell + 0.5) * fine;

  float l = objLum(centre);
  float e = uParams[3] / 100.0;
  if (e > 0.0) l += objEdge(centre, fine.x) * e * 1.4;
  float contrast = mix(0.4, 3.2, clamp(uParams[2] / 100.0, 0.0, 1.0));
  l = objLevel(centre, clamp(l, 0.0, 1.0), max(fine.x, fine.y) * 6.0, contrast, uParams[8]);

  float thr = uParams[1] / 100.0;
  float algo = uParams[4];
  float t;
  if (algo < 0.5)      t = thr * 2.0 * objBayer4(cell);
  else if (algo < 1.5) t = thr * 2.0 * objBayer8(cell);
  else if (algo < 2.5) t = thr * 2.0 * hash21(cell * 0.137 + 3.7);
  else {
    // Halftone: an amplitude-modulated dot inside the cell rather than a
    // per-cell threshold, so the tone reads as dot GAIN the way a press does.
    vec2 d = (lp - centre) / fine;
    float r = length(d) * 2.0;
    t = r * r * max(thr * 2.0, 0.02);
  }
  float on = step(t, l);

  float region = objRegion(centre, uParams[5], uParams[6] / 100.0);
  vec3 ink = uColors[0];
  vec3 paper = uColors[1];
  float paperA = clamp(uParams[9] / 100.0, 0.0, 1.0) * region;
  float inkA = on * region;

  vec3 straight = unpremult(src);
  // Paper first (it is the ground the ink prints on), then ink over it. Both are
  // gated by the region, so "Subject only" leaves the rest of the layer untouched
  // instead of painting a rectangle of paper over it.
  vec3 col = mix(straight, paper, paperA);
  col = mix(col, ink, inkA);
  // Alpha is the LAYER's, untouched: the print lives inside the picture, it does
  // not extend it — and an effect that re-multiplies by src.a must stay out of
  // the clip-to-matte default or a semi-transparent plate gets its alpha squared
  // (the Fill lesson, project_fill_overlay_effect).
  return premult(col, src.a);
}
`;

export const OBJECT_DITHER_ID = 'objectDither';

const OBJECT_DITHER = {
  id: OBJECT_DITHER_ID,
  name: 'Dither Print',
  group: 'Object',
  scopes: ['layer'],
  layerMatte: 'expand',
  usesTrack: true,
  animated: false,
  params: [
    { key: 'pitch', slot: 0, label: 'Grain pitch', min: 1, max: 32, step: 0.25, default: 6, suffix: 'px' },
    { key: 'threshold', slot: 1, label: 'Threshold', min: 0, max: 100, step: 1, default: 52, suffix: '%' },
    { key: 'contrast', slot: 2, label: 'Contrast', min: 0, max: 100, step: 1, default: 55, suffix: '%' },
    { key: 'edge', slot: 3, label: 'Edge preserve', min: 0, max: 100, step: 1, default: 30, suffix: '%' },
    { key: 'paperAmount', slot: 9, label: 'Paper', min: 0, max: 100, step: 1, default: 100, suffix: '%' },
    { key: 'subjectDetail', slot: 7, label: 'Subject detail', min: 0, max: 100, step: 1, default: 0, suffix: '%' },
    {
      key: 'algo', slot: 4, label: 'Screen', type: 'select', primary: true, default: 0,
      options: [
        { value: 0, label: 'Bayer 4×4' },
        { value: 1, label: 'Bayer 8×8' },
        { value: 2, label: 'Noise' },
        { value: 3, label: 'Halftone dots' },
      ],
    },
    {
      key: 'autoLevel', slot: 8, label: 'Auto level', type: 'select', default: 1,
      options: [{ value: 0, label: 'Off' }, { value: 1, label: 'Local' }],
    },
    ...REGION_PARAMS(5, 6),
    ...TRACK_PARAMS(),
    { key: 'ink', type: 'color', colorSlot: 0, label: 'Ink', default: '#7fe3ff' },
    { key: 'paper', type: 'color', colorSlot: 1, label: 'Paper', default: '#06131b' },
  ],
  colorPresets: [
    { name: 'Cyan press', colors: ['#7fe3ff', '#06131b'], params: { algo: 0, pitch: 6, threshold: 52, contrast: 55, edge: 30 } },
    { name: 'Newsprint', colors: ['#161616', '#f2ede2'], params: { algo: 3, pitch: 9, threshold: 54, contrast: 62, edge: 12 } },
    { name: 'Risograph', colors: ['#ff4d6d', '#fff6e8'], params: { algo: 2, pitch: 5, threshold: 48, contrast: 70, edge: 24 } },
    { name: 'Subject only', colors: ['#ffffff', '#000000'], params: { algo: 1, region: 1, regionSoft: 22, subjectDetail: 60, paperAmount: 0 } },
  ],
  fragment: DITHER_FX,
};

/* ── N3 · FIELD ISOLINES ──────────────────────────────────────────────────── */
/*
 * The one program that draws the DETECTION itself — level sets of the weight
 * field, stepped out from the silhouette like a contour map. It is also the
 * fastest way for a user to SEE what their scan actually found, which is why it
 * ships in the first drop.
 *
 * The lab walked marching squares over a blurred copy of the field. A fragment
 * cannot march, so the level set is drawn as a distance-to-level band: with the
 * field's own gradient in hand, (f - level)/|∇f| is the signed distance to that
 * contour in layer units, and a smoothstep across it is a line of constant WIDTH
 * — which is what the marching-squares stroke was approximating anyway.
 */
const ISOLINES_FX = /* glsl */ `
${OBJ_PRELUDE}

// The field, smoothed by r (layer uv). Ring SPACING is this radius: the blur is
// what pushes the level sets apart, exactly as in the lab.
float objField(vec2 p, float r) {
  float s = trkFieldAt(p);
  s += trkFieldAt(p + vec2( r, 0.0));
  s += trkFieldAt(p + vec2(-r, 0.0));
  s += trkFieldAt(p + vec2(0.0,  r));
  s += trkFieldAt(p + vec2(0.0, -r));
  s += trkFieldAt(p + vec2( r,  r) * 0.7071);
  s += trkFieldAt(p + vec2(-r, -r) * 0.7071);
  s += trkFieldAt(p + vec2( r, -r) * 0.7071);
  s += trkFieldAt(p + vec2(-r,  r) * 0.7071);
  return s / 9.0;
}

vec4 fx(vec2 uv) {
  vec4 src = texture2D(uTexture, uv);
  if (!trkHasField()) return src;          // nothing scanned — exact pass-through

  vec2 lp = fxLocal(uv);
  vec2 res = fxRes();
  float r = max(uParams[1], 0.5) / 64.0;   // spacing, in FIELD CELLS (the field is 64²)
  float f = objField(lp, r);
  float gx = objField(lp + vec2(r, 0.0), r) - objField(lp - vec2(r, 0.0), r);
  float gy = objField(lp + vec2(0.0, r), r) - objField(lp - vec2(0.0, r), r);
  vec2 grad = vec2(gx, gy) / (2.0 * r);
  float gl = max(length(grad), 1e-3);

  float rings = max(1.0, floor(uParams[0] + 0.5));
  float inward = floor(rings * clamp(uParams[2] / 100.0, 0.0, 1.0) + 0.5);
  float halfW = max(uParams[3], 0.05) * 0.5 / max(res.y, 1.0);
  float dashPx = max(uParams[4], 0.0);
  float fade = clamp(uParams[5] / 100.0, 0.0, 1.0);

  vec3 acc = vec3(0.0);
  float cov = 0.0;
  for (int i = 0; i < 24; i++) {
    if (float(i) >= rings) break;
    float fi = float(i);
    bool outward = fi >= inward;
    float k = outward
      ? (fi - inward + 1.0) / (rings - inward + 1.0)
      : (inward - fi) / (inward + 1.0);
    float level = outward ? 0.5 - k * 0.46 : 0.5 + k * 0.46;
    float d = abs(f - level) / gl;                       // layer-uv distance to the ring
    float line = 1.0 - smoothstep(halfW * 0.6, halfW * 1.4, d);
    if (line <= 0.0) continue;
    if (dashPx > 0.0) {
      // Dashes march ALONG the contour: the tangent is the gradient's normal.
      vec2 tangent = normalize(vec2(-grad.y, grad.x) + 1e-6);
      float s = dot(lp * res, tangent);
      line *= step(0.35, fract(s / max(dashPx * 1.8, 1.0)));
    }
    float a = line * mix(1.0, max(1.0 - k, 0.05), fade);
    // The silhouette's own ring (the first outward one) is the accent, the
    // outward steps the ink, the inward steps the second ink. Same tiering the
    // lab settled on, and the reason the drawing reads as a MAP not a blur.
    vec3 col = abs(fi - inward) < 0.5 ? uColors[2] : (outward ? uColors[0] : uColors[1]);
    acc += col * a;
    cov += a;
  }
  if (cov <= 0.0) return src;
  vec3 ink = acc / cov;
  float region = objRegion(lp, uParams[6], uParams[7] / 100.0);
  float a = clamp(cov, 0.0, 1.0) * region;

  vec3 straight = unpremult(src);
  vec3 col = mix(straight, ink, a);
  return premult(col, src.a);
}
`;

export const OBJECT_ISOLINES_ID = 'objectIsolines';

const OBJECT_ISOLINES = {
  id: OBJECT_ISOLINES_ID,
  name: 'Field Isolines',
  group: 'Object',
  scopes: ['layer'],
  layerMatte: 'expand',
  usesTrack: true,
  animated: false,
  params: [
    { key: 'rings', slot: 0, label: 'Rings', min: 1, max: 24, step: 1, default: 8 },
    { key: 'spacing', slot: 1, label: 'Ring spacing', min: 1, max: 14, step: 0.5, default: 4, suffix: ' cells' },
    { key: 'inward', slot: 2, label: 'Inward rings', min: 0, max: 100, step: 1, default: 35, suffix: '%' },
    { key: 'weight', slot: 3, label: 'Line weight', min: 0.2, max: 5, step: 0.1, default: 1.1, suffix: 'px' },
    { key: 'dash', slot: 4, label: 'Dash', min: 0, max: 40, step: 1, default: 0, suffix: 'px' },
    { key: 'fade', slot: 5, label: 'Fade out', min: 0, max: 100, step: 1, default: 70, suffix: '%' },
    ...REGION_PARAMS(6, 7),
    ...TRACK_PARAMS(),
    { key: 'ink', type: 'color', colorSlot: 0, label: 'Outward', default: '#7fe3ff' },
    { key: 'inkIn', type: 'color', colorSlot: 1, label: 'Inward', default: '#3b82f6' },
    { key: 'accent', type: 'color', colorSlot: 2, label: 'Silhouette', default: '#ffffff' },
  ],
  colorPresets: [
    { name: 'Contour map', colors: ['#7fe3ff', '#3b82f6', '#ffffff'], params: { rings: 8, spacing: 4, inward: 35, weight: 1.1, fade: 70 } },
    { name: 'Radar', colors: ['#38f8b0', '#0d7a58', '#eaffee'], params: { rings: 14, spacing: 2.5, inward: 0, weight: 0.8, dash: 6, fade: 85 } },
    { name: 'Heavy print', colors: ['#111111', '#555555', '#e53935'], params: { rings: 5, spacing: 6, inward: 20, weight: 2.6, fade: 30 } },
  ],
  fragment: ISOLINES_FX,
};

/* ── 08A · PORTRAIT WINDOW ────────────────────────────────────────────────── */
/*
 * A treated window locked to what was detected. The lab locks it to the FACE box;
 * this adds the subject bounds and the frame as targets, because the same window
 * is the right annotation for a product shot with no face in it.
 *
 * With nothing scanned the window falls back to a centred box rather than drawing
 * the lab's "NO FACE" placeholder: a placeholder would export.
 */
const WINDOW_FX = /* glsl */ `
${OBJ_PRELUDE}

vec4 fx(vec2 uv) {
  vec4 src = texture2D(uTexture, uv);
  vec2 lp = fxLocal(uv);
  vec2 res = fxRes();

  float target = uParams[0];
  vec4 b = target < 0.5 ? trkFaceBox() : (target < 1.5 ? trkSubjectBox() : vec4(0.0, 0.0, 1.0, 1.0));
  float pad = uParams[1] / 100.0;
  vec2 bo = vec2(b.x - b.z * pad * 0.5, b.y - b.w * pad * 0.5);
  vec2 bs = vec2(b.z * (1.0 + pad), b.w * (1.0 + pad));
  bs = max(bs, vec2(0.01));

  vec2 q = (lp - bo) / bs;                 // 0..1 inside the window
  bool inside = q.x > 0.0 && q.x < 1.0 && q.y > 0.0 && q.y < 1.0;

  vec3 straight = unpremult(src);
  vec3 col = straight;

  if (inside) {
    float treat = uParams[3];
    float pitchPx = max(1.5, uParams[2] * (res.y / 1080.0));
    vec2 cellUv = vec2(pitchPx) / max(res, vec2(1.0));
    if (treat < 0.5) {
      // Halftone: paper, then a dot per cell whose radius is the tone.
      vec2 cell = floor(lp / cellUv);
      vec2 centre = (cell + 0.5) * cellUv;
      float l = clamp(objLum(centre), 0.0, 1.0);
      vec2 d = (lp - centre) / cellUv;
      float rr = length(d) * 2.0;
      float dot_ = 1.0 - smoothstep(sqrt(l) * 0.98, sqrt(l) * 1.12, rr);
      col = mix(uColors[1], uColors[0], dot_);
    } else if (treat < 1.5) {
      // Engrave: horizontal rules displaced by the inverse of the tone.
      float row = lp.y / cellUv.y;
      float l = clamp(objLum(lp), 0.0, 1.0);
      float wob = sin(lp.x * res.x * 0.25) * (1.0 - l) * 0.45;
      float dRow = abs(fract(row + wob) - 0.5) * 2.0;
      float line = 1.0 - smoothstep(0.55, 0.95, dRow);
      col = mix(uColors[1], uColors[0], line);
    }
    // treat >= 1.5 — Source: the window shows the picture untouched, and only the
    // frame below marks it out.
  }

  // Frame + corner brackets + the tick marks that make it read as a register mark
  // rather than a rectangle.
  float frameAmt = clamp(uParams[4] / 100.0, 0.0, 1.0);
  if (frameAmt > 0.0) {
    vec2 px = 1.0 / max(res, vec2(1.0));
    vec2 dEdge = min(abs(lp - bo), abs(lp - (bo + bs)));
    bool band = (dEdge.x < px.x * 1.4 && lp.y > bo.y - px.y && lp.y < bo.y + bs.y + px.y)
             || (dEdge.y < px.y * 1.4 && lp.x > bo.x - px.x && lp.x < bo.x + bs.x + px.x);
    float k = min(bs.x, bs.y) * 0.12;
    bool nearCornerX = min(abs(lp.x - bo.x), abs(lp.x - (bo.x + bs.x))) < k;
    bool nearCornerY = min(abs(lp.y - bo.y), abs(lp.y - (bo.y + bs.y))) < k;
    bool bracket = ((dEdge.x < px.x * 2.6 && nearCornerY) || (dEdge.y < px.y * 2.6 && nearCornerX))
      && lp.x > bo.x - px.x && lp.x < bo.x + bs.x + px.x
      && lp.y > bo.y - px.y && lp.y < bo.y + bs.y + px.y;
    if (band || bracket) col = mix(col, uColors[2], frameAmt);
  }

  return premult(col, src.a);
}
`;

export const OBJECT_WINDOW_ID = 'objectWindow';

const OBJECT_WINDOW = {
  id: OBJECT_WINDOW_ID,
  name: 'Portrait Window',
  group: 'Object',
  scopes: ['layer'],
  layerMatte: 'expand',
  usesTrack: true,
  animated: false,
  params: [
    {
      key: 'target', slot: 0, label: 'Lock to', type: 'select', primary: true, default: 0, track: true,
      options: [
        { value: 0, label: 'Face box' },
        { value: 1, label: 'Subject bounds' },
        { value: 2, label: 'Whole layer' },
      ],
    },
    {
      key: 'treatment', slot: 3, label: 'Treatment', type: 'select', primary: true, default: 0,
      options: [
        { value: 0, label: 'Halftone' },
        { value: 1, label: 'Engrave' },
        { value: 2, label: 'Source (sharp)' },
      ],
    },
    { key: 'pad', slot: 1, label: 'Padding', min: 0, max: 200, step: 5, default: 60, suffix: '%' },
    { key: 'pitch', slot: 2, label: 'Dot / line pitch', min: 2, max: 30, step: 0.5, default: 7, suffix: 'px' },
    { key: 'frame', slot: 4, label: 'Frame + ticks', min: 0, max: 100, step: 1, default: 80, suffix: '%' },
    ...TRACK_PARAMS(),
    { key: 'ink', type: 'color', colorSlot: 0, label: 'Ink', default: '#7fe3ff' },
    { key: 'paper', type: 'color', colorSlot: 1, label: 'Paper', default: '#06131b' },
    { key: 'frameColor', type: 'color', colorSlot: 2, label: 'Frame', default: '#ffffff' },
  ],
  colorPresets: [
    { name: 'Portrait', colors: ['#7fe3ff', '#06131b', '#ffffff'], params: { target: 0, treatment: 0, pad: 60, pitch: 7, frame: 80 } },
    { name: 'Engraved plate', colors: ['#f4f1e8', '#1a1713', '#f4f1e8'], params: { target: 0, treatment: 1, pad: 40, pitch: 5, frame: 55 } },
    { name: 'Register mark', colors: ['#ffffff', '#000000', '#ff3b30'], params: { target: 1, treatment: 2, pad: 12, frame: 100 } },
  ],
  fragment: WINDOW_FX,
};


/* ── N1 · SLIT SCAN ───────────────────────────────────────────────────────── */
/*
 * Strips of the picture, each slid by the subject field. Invented for us, not in
 * the reference — and it exists only because a subject field is already there:
 * HOLD SUBJECT keeps high-weight strips still while the background shears, which
 * is the one thing an ordinary slit-scan cannot do.
 *
 * The lab drew this with drawImage per strip. As a fragment it inverts: a
 * fragment works out which strip it is in, computes that strip's displacement
 * from the drive sampled at the STRIP CENTRE (never at the fragment — that would
 * shear the strip instead of sliding it), and reads the plate at the displaced
 * position. Displacement wraps inside the layer box, so a strip never runs out of
 * picture.
 */
const SLIT_FX = /* glsl */ `
${OBJ_PRELUDE}

vec4 fx(vec2 uv) {
  vec4 src = texture2D(uTexture, uv);
  vec2 lp = fxLocal(uv);
  vec2 res = fxRes();

  bool vertical = uParams[0] < 0.5;
  float n = max(2.0, floor(uParams[1] + 0.5));
  float a = vertical ? lp.x : lp.y;
  float idx = floor(a * n);
  float mid = (idx + 0.5) / n;
  vec2 probe = vertical ? vec2(mid, 0.5) : vec2(0.5, mid);

  // The strip's own drive value, in -1..1.
  float drive = uParams[3];
  float f;
  if (drive < 0.5) {
    f = trkFieldAt(probe) * 2.0 - 1.0;
  } else if (drive < 1.5) {
    f = clamp(objEdge(probe, 2.0 / max(res.y, 1.0)) * 4.0, 0.0, 2.0) - 1.0;
  } else if (drive < 2.5) {
    f = sin(idx * 0.35 + uTime * max(uParams[6], 0.0));
  } else {
    f = hash21(vec2(idx * 0.013 + uParams[7], idx * 0.07)) * 2.0 - 1.0;
  }

  // Hold: a high-weight strip stays put. With no scan the field is flat 1.0, so
  // Hold 100% freezes everything — which is the honest reading of "hold the
  // subject" when the whole layer IS the subject.
  float hold = 1.0 - (uParams[4] / 100.0) * clamp(trkFieldAt(probe), 0.0, 1.0);
  float off = f * (uParams[2] / 100.0) * hold;

  vec2 sp = lp;
  if (vertical) sp.y = fract(lp.y - off + 2.0);
  else sp.x = fract(lp.x + off + 2.0);
  vec4 moved = sampleClamped(uTexture, fxFrame(sp));

  // Strip gap: a slice taken off the far edge of every strip.
  float gapUv = (uParams[5] * (res.y / 1080.0)) / max(vertical ? res.x : res.y, 1.0);
  float inGap = step(1.0 - gapUv * n, fract(a * n));

  float region = objRegion(probe, uParams[8], uParams[9] / 100.0);
  vec3 straight = unpremult(src);
  vec3 col = mix(straight, unpremult(moved), region);
  float alpha = src.a * (1.0 - inGap * region);
  return premult(col, alpha);
}
`;

export const OBJECT_SLIT_ID = 'objectSlitScan';

const OBJECT_SLIT = {
  id: OBJECT_SLIT_ID,
  name: 'Slit Scan',
  group: 'Object',
  scopes: ['layer'],
  layerMatte: 'expand',
  usesTrack: true,
  animated: true,
  params: [
    {
      key: 'dir', slot: 0, label: 'Strips', type: 'select', primary: true, default: 1,
      options: [{ value: 0, label: 'Vertical' }, { value: 1, label: 'Horizontal' }],
    },
    {
      key: 'drive', slot: 3, label: 'Driven by', type: 'select', primary: true, default: 1,
      options: [
        { value: 0, label: 'Subject field' },
        { value: 1, label: 'Edge strength' },
        { value: 2, label: 'Standing wave' },
        { value: 3, label: 'Random' },
      ],
    },
    { key: 'count', slot: 1, label: 'Strips', min: 4, max: 400, step: 2, default: 84 },
    { key: 'shift', slot: 2, label: 'Displacement', min: 0, max: 60, step: 0.5, default: 3.5, suffix: '%' },
    { key: 'hold', slot: 4, label: 'Hold subject', min: 0, max: 100, step: 1, default: 61, suffix: '%' },
    { key: 'gap', slot: 5, label: 'Strip gap', min: 0, max: 20, step: 0.5, default: 5, suffix: 'px' },
    {
      key: 'waveSpeed', slot: 6, label: 'Wave speed', min: 0, max: 8, step: 0.1, default: 1.6,
      showIf: { key: 'drive', equals: 2 },
    },
    { key: 'seed', slot: 7, label: 'Seed', min: 0, max: 999, step: 1, default: 7, static: true, showIf: { key: 'drive', equals: 3 } },
    ...REGION_PARAMS(8, 9),
    ...TRACK_PARAMS({ trackSource: 1, trackFeather: 0, trackFaceBoost: 30 }),
  ],
  colorPresets: [
    { name: 'Hold the subject', colors: [], params: { drive: 0, count: 90, shift: 14, hold: 100 } },
    { name: 'Edge shear', colors: [], params: { drive: 1, count: 160, shift: 22, hold: 0 } },
    { name: 'Standing wave', colors: [], params: { drive: 2, count: 60, shift: 18, waveSpeed: 1.6 } },
    { name: 'Shredder', colors: [], params: { drive: 3, count: 240, shift: 30, gap: 2 } },
  ],
  fragment: SLIT_FX,
};

/* ── 08 · SPECTRAL CURTAIN ────────────────────────────────────────────────── */
/*
 * The colour of strong contours, pushed vertically out of frame.
 *
 * The lab picks contour points from the shared extraction and draws a gradient
 * rect under each. There is no point set in a fragment, so this inverts it: a
 * fragment MARCHES back along the extrusion axis looking for the first strong
 * luminance step in its band, and paints that pixel's colour with a falloff by
 * how far it travelled. Same picture — colour hanging off contours — from the one
 * thing a fragment is good at.
 *
 * The march measures |dLuma| between consecutive taps, not a Sobel: walking the
 * axis IS the derivative along it, so the whole effect costs ONE plate sample per
 * tap instead of four.
 */
const CURTAIN_FX = /* glsl */ `
${OBJ_PRELUDE}

vec4 fx(vec2 uv) {
  vec4 src = texture2D(uTexture, uv);
  vec2 lp = fxLocal(uv);
  vec2 res = fxRes();

  float bandPx = max(uParams[3], 0.5) * (res.y / 1080.0);
  float bandW = max(bandPx / max(res.x, 1.0), 1e-4);
  float bi = floor(lp.x / bandW);
  float centre = (bi + 0.5) * bandW;
  // Density thins the lattice: a hashed subset of bands lights, so the count
  // reads like the reference's scattered curtain rather than a comb.
  float density = clamp(uParams[1] / 400.0, 0.01, 1.0);
  if (hash21(vec2(bi, 7.3)) > density) return src;

  float maxLen = clamp(uParams[2] / 100.0, 0.01, 1.0);
  float dirMode = uParams[4];
  int taps = uQuality < 0.75 ? 24 : 48;

  vec3 hitCol = vec3(0.0);
  float hitT = -1.0;
  float hitE = 0.0;
  // Two marches, one per direction: 0 Down (the contour is ABOVE the fragment,
  // since layer +y is up), 1 Up, 2 Both. Whichever finds a contour FIRST wins,
  // so in Both mode a fragment is lit by the nearer of the two.
  for (int pass_ = 0; pass_ < 2; pass_++) {
    if (pass_ == 0 && dirMode > 0.5 && dirMode < 1.5) continue;   // Up only
    if (pass_ == 1 && dirMode < 0.5) continue;                    // Down only
    float sgn = pass_ == 0 ? 1.0 : -1.0;

    float prev = objLum(vec2(centre, lp.y));
    for (int i = 1; i < 49; i++) {
      if (i > taps) break;
      float t = (float(i) / float(taps)) * maxLen;
      vec2 q = vec2(centre, lp.y + sgn * t);
      if (q.y < 0.0 || q.y > 1.0) break;
      float l = objLum(q);
      // Walking the axis IS the derivative along it, so one plate sample per tap
      // replaces a four-tap Sobel. Scaled by the tap count so the threshold means
      // the same thing at both quality levels.
      float e = abs(l - prev) * float(taps) * 0.08;
      prev = l;
      if (e > uParams[5] / 100.0) {
        if (hitT < 0.0 || t < hitT) {
          hitT = t;
          hitE = e;
          vec4 hs = sampleClamped(uTexture, fxFrame(q));
          hitCol = unpremult(hs);
        }
        break;
      }
    }
  }
  if (hitT < 0.0) return src;

  vec3 straight = unpremult(src);
  vec3 band = uParams[6] > 0.5 ? uColors[0] : hitCol;
  float fall = clamp(1.0 - hitT / maxLen, 0.0, 1.0);
  float a = fall * clamp(hitE, 0.0, 1.0) * objRegion(vec2(centre, lp.y), uParams[7], uParams[8] / 100.0);
  vec3 col = mix(straight, clamp(band, 0.0, 1.0), clamp(a, 0.0, 1.0));
  return premult(col, src.a);
}
`;

export const OBJECT_CURTAIN_ID = 'objectCurtain';

const OBJECT_CURTAIN = {
  id: OBJECT_CURTAIN_ID,
  name: 'Spectral Curtain',
  group: 'Object',
  scopes: ['layer'],
  layerMatte: 'expand',
  usesTrack: true,
  animated: false,
  params: [
    {
      key: 'dir', slot: 4, label: 'Direction', type: 'select', primary: true, default: 0,
      options: [{ value: 0, label: 'Down' }, { value: 1, label: 'Up' }, { value: 2, label: 'Both' }],
    },
    { key: 'density', slot: 1, label: 'Density', min: 10, max: 400, step: 5, default: 400, suffix: ' bands' },
    { key: 'length', slot: 2, label: 'Extrusion length', min: 2, max: 100, step: 1, default: 19, suffix: '%' },
    { key: 'width', slot: 3, label: 'Band width', min: 1, max: 40, step: 0.5, default: 6, suffix: 'px' },
    { key: 'threshold', slot: 5, label: 'Contour threshold', min: 1, max: 100, step: 1, default: 18, suffix: '%' },
    {
      key: 'colorMode', slot: 6, label: 'Colour', type: 'select', default: 0,
      options: [{ value: 0, label: 'From the picture' }, { value: 1, label: 'Custom tint' }],
    },
    ...REGION_PARAMS(7, 8),
    ...TRACK_PARAMS({ trackSource: 2 }),
    { key: 'tint', type: 'color', colorSlot: 0, label: 'Tint', default: '#7fe3ff' },
  ],
  colorPresets: [
    { name: 'Curtain', colors: ['#7fe3ff'], params: { dir: 0, density: 140, length: 34, width: 6, colorMode: 0 } },
    { name: 'Rising', colors: ['#ffd27f'], params: { dir: 1, density: 90, length: 55, width: 4, colorMode: 0 } },
    { name: 'Tinted veil', colors: ['#ff6ea9'], params: { dir: 2, density: 220, length: 26, width: 3, colorMode: 1 } },
  ],
  fragment: CURTAIN_FX,
};

/* ── 07B · GRID SYSTEM ────────────────────────────────────────────────────── */
/*
 * Packed editorial modules over the layer — and the thing the plan insists on:
 * NOT a quadtree. Quartering makes every module the same shape, which reads as a
 * debug overlay; the varied aspect ratios ARE the look.
 *
 * The lab builds the layout by splitting whichever module scores worst (big, and
 * not on the subject) until it has N of them — a global priority queue, which a
 * fragment cannot run. The fragment version is a DESCENT: start from the whole
 * box and, at each level, decide LOCALLY whether this node still deserves
 * splitting (its own area, discounted by the subject weight at its centre),
 * then step into whichever child contains the fragment. Same rule, evaluated
 * per node instead of globally — modules over the subject stop early and stay
 * large, the background keeps subdividing, and the split ratios stay hashed so
 * the aspect ratios vary.
 *
 * The micro-label is a TICK BLOCK, not text: a fragment cannot draw "R08 / 123",
 * and a fake glyph would read worse than the barcode-ish mark it becomes at the
 * size the reference prints it.
 */
const GRID_FX = /* glsl */ `
${OBJ_PRELUDE}

vec4 fx(vec2 uv) {
  vec4 src = texture2D(uTexture, uv);
  vec2 lp = fxLocal(uv);
  vec2 res = fxRes();
  float seed = uParams[8];
  float prog = uParams[0];
  float protect = clamp(uParams[2] / 100.0, 0.0, 1.0);
  float stopArea = 1.0 / max(uParams[1], 2.0);

  // ── the descent ──
  vec2 ro = vec2(0.0);
  vec2 rs = vec2(1.0);
  float id = 1.0;
  for (int d = 0; d < 12; d++) {
    vec2 c = ro + rs * 0.5;
    float subj = trkFieldAt(c);
    // A module on the subject is worth LESS splitting, so it survives larger.
    if ((rs.x * rs.y) * (1.0 - subj * protect) <= stopArea) break;
    if (rs.x < 0.055 || rs.y < 0.035) break;
    float h1 = hash21(vec2(id, seed));
    float h2 = hash21(vec2(id * 1.7 + 3.0, seed));
    bool vertical = (rs.x / max(rs.y, 1e-4)) > (0.75 + h1 * 0.8);
    float t = 0.3 + h2 * 0.4;
    if (vertical) {
      if ((lp.x - ro.x) < rs.x * t) { rs.x *= t; id = id * 2.0; }
      else { ro.x += rs.x * t; rs.x *= (1.0 - t); id = id * 2.0 + 1.0; }
    } else {
      if ((lp.y - ro.y) < rs.y * t) { rs.y *= t; id = id * 2.0; }
      else { ro.y += rs.y * t; rs.y *= (1.0 - t); id = id * 2.0 + 1.0; }
    }
  }

  vec2 centre = ro + rs * 0.5;
  float subj = trkFieldAt(centre);
  float region = objRegion(centre, uParams[9], uParams[10] / 100.0);
  if (region <= 0.001) return src;

  // Gutter, authored in px and applied on both axes in layer uv.
  float gutPx = uParams[4] * (res.y / 1080.0);
  vec2 gv = vec2(gutPx / max(res.x, 1.0), gutPx / max(res.y, 1.0));
  vec2 io = ro + gv;
  vec2 is = max(rs - gv * 2.0, vec2(0.002));
  vec2 q = (lp - io) / is;
  if (q.x < 0.0 || q.x > 1.0 || q.y < 0.0 || q.y > 1.0) return src;   // in the gutter

  // Fragment program: some modules are simply missing.
  if (prog > 1.5 && prog < 2.5 && hash21(vec2(id * 7.7, seed + 5.0)) < 0.3) return src;

  bool open = hash21(vec2(id * 3.1, seed + 11.0)) < uParams[5] / 100.0;
  // Editorial: the subject's own modules are the negative space the photo reads
  // through, which is the whole point of that program.
  if (prog < 0.5 && subj > 0.55 && hash21(vec2(id * 5.3, seed + 2.0)) < 0.85) open = true;

  vec3 col = unpremult(src);
  float fill = uParams[3] / 100.0;
  if (!open && fill > 0.0) {
    float roll = hash21(vec2(id * 11.0, seed + 23.0));
    vec3 tone = roll < 0.12 ? uColors[1] : (roll < 0.3 ? uColors[2] : uColors[0]);
    float a = (roll < 0.12 ? 0.16 : (roll < 0.3 ? 0.5 : (roll < 0.42 ? 0.2 : 0.3)))
      * fill * mix(1.0, 0.45, subj * protect);
    if (prog > 2.5) a *= 0.7 + 0.45 * (0.5 + 0.5 * sin(uTime * 3.1 + id));
    col = mix(col, tone, clamp(a, 0.0, 1.0) * region);
  }

  vec2 px = q * is * res;                 // px from the module's own top-left
  vec2 edgePx = min(px, is * res - px);
  float wpx = uParams[6] * (res.y / 1080.0);
  if (wpx > 0.0 && min(edgePx.x, edgePx.y) < wpx) {
    col = mix(col, uColors[open ? 0 : 1], (open ? 0.28 : 0.22) * region);
  }

  // Measure: centre ticks on all four sides. Data: a bar whose length reads the
  // module's distance from the subject.
  if (prog > 0.5 && prog < 1.5) {
    float k = min(is.x * res.x, is.y * res.y) * 0.16;
    bool tickH = abs(px.y - is.y * res.y * 0.5) < max(wpx, 0.75)
      && (px.x < k || px.x > is.x * res.x - k);
    bool tickV = abs(px.x - is.x * res.x * 0.5) < max(wpx, 0.75) && px.y < k;
    if (tickH || tickV) col = mix(col, uColors[0], 0.5 * region);
  }
  if (prog > 2.5 && !open) {
    float barW = (is.x * res.x - 12.0) * (0.2 + 0.75 * (1.0 - subj));
    if (px.y > is.y * res.y - 9.0 && px.y < is.y * res.y - 6.0 && px.x > 6.0 && px.x < 6.0 + barW) {
      col = mix(col, uColors[1], 0.35 * region);
    }
  }

  // The micro-label, as a tick block.
  if (uParams[7] > 0.0 && is.x * res.x > 46.0 && is.y * res.y > 22.0
      && hash21(vec2(id * 13.0, seed + 31.0)) < uParams[7] / 100.0) {
    if (px.y > 5.0 && px.y < 11.0 && px.x > 6.0 && px.x < 60.0) {
      float slot = floor((px.x - 6.0) / 3.0);
      if (hash21(vec2(slot + id * 17.0, seed + 7.0)) > 0.45) {
        col = mix(col, uColors[1], 0.55 * region);
      }
    }
  }

  return premult(col, src.a);
}
`;

export const OBJECT_GRID_ID = 'objectGrid';

const OBJECT_GRID = {
  id: OBJECT_GRID_ID,
  name: 'Grid System',
  group: 'Object',
  scopes: ['layer'],
  layerMatte: 'expand',
  usesTrack: true,
  animated: false,
  params: [
    {
      key: 'program', slot: 0, label: 'Program', type: 'select', primary: true, default: 0,
      options: [
        { value: 0, label: 'Editorial / negative space' },
        { value: 1, label: 'Measure / drafting' },
        { value: 2, label: 'Fragment / broken modules' },
        { value: 3, label: 'Data / signal index' },
      ],
    },
    { key: 'modules', slot: 1, label: 'Modules', min: 4, max: 90, step: 1, default: 34 },
    { key: 'protect', slot: 2, label: 'Subject protect', min: 0, max: 100, step: 1, default: 70, suffix: '%' },
    { key: 'fill', slot: 3, label: 'Panel fill', min: 0, max: 100, step: 1, default: 62, suffix: '%' },
    { key: 'gutter', slot: 4, label: 'Gutter', min: 0, max: 24, step: 0.5, default: 5, suffix: 'px' },
    { key: 'open', slot: 5, label: 'Open modules', min: 0, max: 100, step: 1, default: 30, suffix: '%' },
    { key: 'weight', slot: 6, label: 'Line weight', min: 0, max: 4, step: 0.1, default: 0.8, suffix: 'px' },
    { key: 'labels', slot: 7, label: 'Cell labels', min: 0, max: 100, step: 1, default: 40, suffix: '%' },
    { key: 'seed', slot: 8, label: 'Seed', min: 0, max: 999, step: 1, default: 4, static: true },
    ...REGION_PARAMS(9, 10),
    ...TRACK_PARAMS(),
    { key: 'ink', type: 'color', colorSlot: 0, label: 'Ink', default: '#7fe3ff' },
    { key: 'accent', type: 'color', colorSlot: 1, label: 'Accent', default: '#ffffff' },
    { key: 'paper', type: 'color', colorSlot: 2, label: 'Plate', default: '#06131b' },
  ],
  colorPresets: [
    { name: 'Editorial', colors: ['#7fe3ff', '#ffffff', '#06131b'], params: { program: 0, modules: 34, protect: 70, fill: 62, open: 30 } },
    { name: 'Drafting', colors: ['#cfd6e6', '#ffffff', '#0b0f14'], params: { program: 1, modules: 46, fill: 18, weight: 0.8, labels: 70 } },
    { name: 'Broken', colors: ['#ff6ea9', '#ffe9c9', '#12060c'], params: { program: 2, modules: 60, fill: 48, open: 45 } },
    { name: 'Signal index', colors: ['#38f8b0', '#eaffee', '#04120c'], params: { program: 3, modules: 28, fill: 72, labels: 85 } },
  ],
  fragment: GRID_FX,
};

/* ── 01 · CONTOUR STUDIO ──────────────────────────────────────────────────── */
/*
 * Continuous lines following light and contours. Two methods, and the second one
 * is where the shader formulation earns its keep.
 *
 * TOPOGRAPHIC is level sets of the LUMINANCE — the same distance-to-level band
 * Field Isolines draws over the weight field, run over the picture instead, so a
 * face turns into a contour map.
 *
 * FLOW ENGRAVING: the lab seeds points and integrates streamlines PERPENDICULAR
 * to the gradient. A fragment cannot integrate. What it can do is read the local
 * gradient angle and phase a hatch along it — the stripes then curve to follow
 * the edges, which is the same drawing arrived at from the other end. Stroke
 * DENSITY, not stroke count, is what the Lines control means here, and the panel
 * says so.
 */
const CONTOUR_FX = /* glsl */ `
${OBJ_PRELUDE}

// Luminance smoothed by r (layer uv) — Detail picks the radius, so a low Detail
// is the lab's boxBlur and a high one is the raw picture.
float objSmoothLum(vec2 p, float r) {
  if (r <= 0.0) return objLum(p);
  float s = objLum(p);
  s += objLum(p + vec2(r, 0.0));
  s += objLum(p - vec2(r, 0.0));
  s += objLum(p + vec2(0.0, r));
  s += objLum(p - vec2(0.0, r));
  s += objLum(p + vec2(r, r) * 0.7071);
  s += objLum(p - vec2(r, r) * 0.7071);
  s += objLum(p + vec2(r, -r) * 0.7071);
  s += objLum(p + vec2(-r, r) * 0.7071);
  return s / 9.0;
}

vec4 fx(vec2 uv) {
  vec4 src = texture2D(uTexture, uv);
  vec2 lp = fxLocal(uv);
  vec2 res = fxRes();
  float smoothR = mix(3.5, 0.0, clamp(uParams[2] / 100.0, 0.0, 1.0)) / max(res.y, 1.0) * 3.0;

  float f = objSmoothLum(lp, smoothR);
  float texel = 1.5 / max(res.y, 1.0);
  float gx = objSmoothLum(lp + vec2(texel, 0.0), smoothR) - objSmoothLum(lp - vec2(texel, 0.0), smoothR);
  float gy = objSmoothLum(lp + vec2(0.0, texel), smoothR) - objSmoothLum(lp - vec2(0.0, texel), smoothR);
  vec2 grad = vec2(gx, gy) / (2.0 * texel);
  float gl = max(length(grad), 1e-3);

  float halfW = max(uParams[3], 0.05) * 0.5 / max(res.y, 1.0);
  float bias = clamp(uParams[6] / 100.0, 0.0, 1.0);
  float w = mix(1.0, clamp(trkFieldAt(lp), 0.0, 1.0), bias);
  float region = objRegion(lp, uParams[7], uParams[8] / 100.0);

  vec3 acc = vec3(0.0);
  float cov = 0.0;

  if (uParams[0] < 0.5) {
    // Topographic: one band per level, the ink alternating like the lab's.
    float lv = max(floor(uParams[1] + 0.5), 2.0);
    for (int k = 1; k < 40; k++) {
      if (float(k) >= lv) break;
      float level = float(k) / lv;
      float d = abs(f - level) / gl;
      float line = 1.0 - smoothstep(halfW * 0.6, halfW * 1.4, d);
      if (line <= 0.0) continue;
      float a = line * (0.28 + 0.5 * (float(k) / lv));
      acc += (mod(float(k), 2.0) < 0.5 ? uColors[0] : uColors[1]) * a;
      cov += a;
    }
  } else {
    // Flow engraving: hatch phase advances ALONG the contour (perpendicular to
    // the gradient), so the stripes travel with the edge instead of across it.
    vec2 tangent = normalize(vec2(-grad.y, grad.x) + vec2(1e-5));
    float freq = max(uParams[4], 4.0);
    float phase = dot(lp * vec2(fxAspect(), 1.0), tangent) * freq
      + sin(uTime * 0.9) * uParams[5] * 0.02;
    float stripe = abs(fract(phase) - 0.5) * 2.0;
    float line = 1.0 - smoothstep(0.45, 0.95, stripe);
    // Where the picture is flat there is no direction to engrave along, so the
    // hatch fades out instead of printing a grid over the sky.
    float strength = clamp(gl * 0.35, 0.0, 1.0);
    float a = line * strength;
    acc += uColors[0] * a;
    cov += a;
  }

  if (cov <= 0.0) return src;
  vec3 ink = acc / cov;
  float a = clamp(cov, 0.0, 1.0) * w * region;
  vec3 straight = unpremult(src);
  return premult(mix(straight, ink, a), src.a);
}
`;

export const OBJECT_CONTOUR_ID = 'objectContour';

const OBJECT_CONTOUR = {
  id: OBJECT_CONTOUR_ID,
  name: 'Contour Studio',
  group: 'Object',
  scopes: ['layer'],
  layerMatte: 'expand',
  usesTrack: true,
  animated: true,
  params: [
    {
      key: 'method', slot: 0, label: 'Method', type: 'select', primary: true, default: 0,
      options: [{ value: 0, label: 'Topographic' }, { value: 1, label: 'Flow engraving' }],
    },
    { key: 'levels', slot: 1, label: 'Levels', min: 2, max: 40, step: 1, default: 14, showIf: { key: 'method', equals: 0 } },
    { key: 'detail', slot: 2, label: 'Detail', min: 0, max: 100, step: 1, default: 60, suffix: '%' },
    { key: 'weight', slot: 3, label: 'Line weight', min: 0.2, max: 4, step: 0.1, default: 1, suffix: 'px' },
    { key: 'density', slot: 4, label: 'Hatch density', min: 10, max: 400, step: 5, default: 120, showIf: { key: 'method', equals: 1 } },
    { key: 'drift', slot: 5, label: 'Hatch drift', min: 0, max: 100, step: 1, default: 0, suffix: '%', showIf: { key: 'method', equals: 1 } },
    { key: 'subjectBias', slot: 6, label: 'Subject bias', min: 0, max: 100, step: 1, default: 0, suffix: '%' },
    ...REGION_PARAMS(7, 8),
    ...TRACK_PARAMS(),
    { key: 'ink', type: 'color', colorSlot: 0, label: 'Ink', default: '#7fe3ff' },
    { key: 'accent', type: 'color', colorSlot: 1, label: 'Accent', default: '#ffffff' },
  ],
  colorPresets: [
    { name: 'Topographic', colors: ['#7fe3ff', '#ffffff'], params: { method: 0, levels: 14, detail: 60, weight: 1 } },
    { name: 'Fine map', colors: ['#cfd6e6', '#ffffff'], params: { method: 0, levels: 28, detail: 85, weight: 0.6 } },
    { name: 'Engraving', colors: ['#111111', '#555555'], params: { method: 1, density: 160, weight: 1.2, detail: 70 } },
    { name: 'Subject only', colors: ['#38f8b0', '#eaffee'], params: { method: 1, density: 120, subjectBias: 100 } },
  ],
  fragment: CONTOUR_FX,
};

export const OBJECT_EFFECTS = [
  OBJECT_DITHER, OBJECT_ISOLINES, OBJECT_WINDOW,
  OBJECT_SLIT, OBJECT_CURTAIN,
  OBJECT_GRID, OBJECT_CONTOUR,
];

export const OBJECT_EFFECT_IDS = new Set(OBJECT_EFFECTS.map((e) => e.id));

/** Does this effect instance carry its own subject scan? */
export function isObjectEffectId(id) {
  return OBJECT_EFFECT_IDS.has(id);
}

/** The scan options THIS entry authored — what the Scan button sends. */
export function trackScanOptions(eff) {
  const p = eff?.params || {};
  return {
    source: Number.isFinite(p.trackSource) ? p.trackSource : 0,
    feather: Number.isFinite(p.trackFeather) ? p.trackFeather : 2,
    faceBoost: (Number.isFinite(p.trackFaceBoost) ? p.trackFaceBoost : 100) / 100,
  };
}

/**
 * The file a URL points at, in the same form the scan stamps on the track.
 * Origin-free on purpose — see objectScanProcessor's mediaSig.
 */
export function trackMediaSig(url) {
  const s = String(url || '');
  if (!s) return '';
  try { return new URL(s, 'http://x').pathname.split('/').filter(Boolean).pop() || s.slice(-80); }
  catch { return s.slice(-80); }
}

/**
 * Is the stored track still the one these controls would produce? Returns the
 * REASON (what to tell the user) or null when the scan still matches.
 *
 * Detect is not the only scan option: Field feather and Face weight are baked
 * into the stored field by the worker, and the scan only covered the trim it was
 * run on. Comparing `src` alone left all three changing nothing, with no hint
 * that a re-scan was needed — the card looked broken rather than stale.
 */
export function trackIsStale(eff, ctx = null) {
  const t = eff?.track;
  if (!t) return null;
  const opts = trackScanOptions(eff);
  if (Number(t.src) !== Number(opts.source)) return 'Detect setting';
  const sig = t.scan;
  // Tracks scanned before the signature existed can only be checked on Detect.
  if (!sig) return null;
  if (Math.abs(Number(sig.feather) - opts.feather) > 1e-6) return 'Field feather';
  if (Math.abs(Number(sig.faceBoost) - opts.faceBoost) > 1e-6) return 'Face weight';
  if (ctx) {
    const media = trackMediaSig(ctx.url);
    if (media && sig.media && media !== sig.media) return 'media file';
    if (t.kind === 'video' && Number.isFinite(Number(ctx.trimEnd))) {
      // A trim extended past the sampled window holds the last field to the end
      // of the clip: the subject appears to stop moving, with nothing to say why.
      if (Number(ctx.trimEnd) > Number(sig.to) + 0.25) return 'trim';
      if (Number(ctx.trimStart) < Number(sig.from) - 0.25) return 'trim';
    }
  }
  return null;
}
