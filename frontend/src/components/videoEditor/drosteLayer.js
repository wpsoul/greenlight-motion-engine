import * as THREE from 'three';

/*
 * Droste — geometry layer effect (port of html/droste-lab.html, Escher's Print Gallery).
 *
 * The layer falls into itself, forever, in ONE fragment pass. No level loop, no
 * feedback buffer, no second target: the recursion is a `mod` in log-polar space.
 *
 *   q      = (b - centre) * 2                 box uv (y down), 1.0 = the box edge
 *   rho    = shapeNorm(q)                     superellipse "radius", 1 on the shape
 *   w      = (log rho, atan2(q.y, q.x))       log-polar — SCALING becomes a SHIFT
 *   w'     = A * w,   A = 1 - i*c             one complex multiply = the Escher twist
 *            c = twist * L / 2PI,  L = log(r2/r1)
 *   w'.x   = mod(w'.x, L)                     <- every level, at once
 *   q'     = exp(w'.x) * dir(w'.y) / shapeNorm(dir(w'.y))
 *
 * Four things about that are load-bearing, and all four were settled in the lab:
 *
 *  - A IS A COMPLEX MULTIPLY, NOT A SHEAR. `A = 1 - i*c` is exactly Lenstra's gamma
 *    for Print Gallery (z ↦ z^A), which is why `w'.y = v - c*u` comes along with it
 *    and the map stays CONFORMAL: the picture rotates into the spiral instead of
 *    being squashed into it. Shifting the log-radius alone is the cheap version and
 *    it visibly shears the artwork. Do not add the `cos(alpha)` compensation some
 *    published Droste shaders carry — it breaks single-valuedness (next point).
 *
 *  - SEAMLESS EXACTLY WHEN `droTwist` IS A WHOLE NUMBER. One turn around theta adds
 *    twist*L to the log-radius, so a fractional twist leaves a real discontinuity on
 *    the theta = 180° ray. It is a legitimate look (Escher's own print has its famous
 *    blank spot) but it is never an accident anyone wants, so the panel says so and
 *    the field steps in whole levels by default.
 *
 *  - shapeNorm IS A SUPERELLIPSE, and the RECTANGLE case is the one motion design
 *    actually asks for. k = 2 is the true conformal Droste (circles); k >= 13
 *    short-circuits to max(|x|,|y|) and nests the LAYER'S OWN RECT — the layer inside
 *    itself, which is what "infinite frame" means to everyone who asks for it.
 *
 *  - THE CENTRE IS INFINITELY FINE, so it is SUPERSAMPLED, adaptively, and then faded.
 *    The lab could reach for `textureLod` because it owns its source texture and can
 *    mip it; the app's source is a POOLED SCRATCH ISOLATE with no mip chain and a
 *    LinearFilter, so an explicit LOD would silently return level 0 and shimmer. The
 *    jacobian is analytic (|dq'/dq| = |A|·rho'/rho, and because source and output share
 *    one pixel grid that number IS the footprint in pixels), so the tap count is chosen
 *    per fragment from it and the last few pixels — where no tap budget can win — fade
 *    out. Derivatives are useless here for the same reason mips would be: `mod` tears
 *    them at every level boundary, which is exactly where the detail is.
 *
 * Coordinate conventions, shared with every other warp ([cornerPinLayer.js]):
 *  - Authored params are PERCENT OF THE LAYER BOX, +y DOWN, like every other % field.
 *  - The shader works in box uv `b` ∈ [0,1]², +y DOWN, so the lab math ports verbatim.
 *  - Sampling converts box uv → frame uv through the computeLayerBox affine, because
 *    the isolate is a FULL-FRAME target in which the layer occupies a sub-rect. Edge
 *    handling is therefore in BOX units; a texture wrap would wrap the whole frame.
 *
 * Unlike the other fragment warps this quad is NOT overscanned. The fold guarantees
 * every output point inside the box resolves to a sample, and Droste is a resample of
 * the layer, not a displacement of it — it must not grow the layer's footprint.
 */

export const DROSTE_LAYER_EFFECT_ID = 'droste';

// ── PRO gating (containsProGlowEffect precedent) ────────────────────────────
// Droste is a PRO effect, gated exactly like Running Glow, the Rig, Motion Trail
// and Grow Fill: free to design and play back in the preview, paywalled at render.
// The check lives here rather than in a list of feature ids because there is
// nothing to keep in sync — the effect IS the flag. See the gate in VideoEditor's
// handleRenderInBackground.
export const DRO_IS_PRO = true;

export const DRO_DEFAULTS = {
  // shape — where the recursion lives and what shape nests
  droR1: 32,            // % — inner radius: the hole the next level falls into
  droR2: 100,           // % — outer radius: 100 = the layer's own edge
  droShape: 100,        // -100 diamond … 0 circle … 100 rectangle
  droFit: 0,            // 0 = follow the layer box, 1 = square (a circle stays round)
  droStretch: 100,      // % — widen the shape on its x axis
  droCX: 50,            // % of box, y down
  droCY: 50,
  // spiral
  droTwist: 0,          // levels per turn. WHOLE numbers are seamless.
  droSpin: 0,           // °
  droZoom: 0,           // levels — continuous, and one whole level is a closed loop
  droTiling: 0,         // 0 repeat, 1 mirror
  // depth
  droFade: 0,           // % darker per level
  droTintAmount: 0,     // %
  droTint: '#0b1436',
  // COPIES. Stored as `droDepthLimit` because that is the key the effect shipped
  // with — a rename would be a data migration (the sanitizer is a per-key whitelist
  // and would silently drop the old one) for a purely cosmetic gain.
  droDepthLimit: 0,     // how many copies are drawn. 0 = endless.
  droVoidOpacity: 0,    // %
  droVoid: '#000000',
  // motion — rates, deliberately NOT keyframable (phase = t·speed jumps on a track)
  droZoomSpeed: 0,      // levels/s
  droSpinSpeed: 0,      // °/s
  // sampling
  droEdge: 0,           // outside the box: transparent / clamp / repeat / mirror
  droQuality: 1,        // 0 fast (1 tap), 1 smooth (≤4), 2 best (≤16)
  droDetail: 0,         // ± how deep the core is chased before it fades
  droAmount: 100,       // % master mix (keyframable)
};

export const DRO_NUMBER_FIELDS = [
  { key: 'droR1', label: 'Inner Radius', min: 2, max: 95, step: 0.5, suffix: '%', kf: true, group: 'shape' },
  { key: 'droR2', label: 'Outer Radius', min: 20, max: 200, step: 0.5, suffix: '%', kf: true, group: 'shape' },
  { key: 'droShape', label: 'Shape', min: -100, max: 100, step: 1, kf: true, group: 'shape' },
  { key: 'droStretch', label: 'Stretch', min: 0, max: 250, step: 1, suffix: '%', kf: true, group: 'shape' },
  { key: 'droCX', label: 'Centre X', min: -50, max: 150, step: 0.5, suffix: '%', kf: true, group: 'shape' },
  { key: 'droCY', label: 'Centre Y', min: -50, max: 150, step: 0.5, suffix: '%', kf: true, group: 'shape' },
  // Step 0.05 so the fractional-twist look (a deliberate spiral CUT, Escher's own
  // blank spot) stays reachable, but whole numbers land exactly on the step grid —
  // which is what "seamless" means here. The card's summary says which side you are on.
  { key: 'droTwist', label: 'Twist', min: -3, max: 3, step: 0.05, suffix: ' lv', kf: true, group: 'spiral' },
  { key: 'droSpin', label: 'Spin', min: -180, max: 180, step: 1, suffix: '°', kf: true, group: 'spiral' },
  { key: 'droZoom', label: 'Zoom', min: -4, max: 4, step: 0.01, suffix: ' lv', kf: true, group: 'spiral' },
  { key: 'droDepthLimit', label: 'Copies', min: 0, max: 20, step: 1, kf: true, group: 'depth' },
  { key: 'droFade', label: 'Depth Fade', min: 0, max: 90, step: 1, suffix: '%', kf: true, group: 'depth' },
  { key: 'droTintAmount', label: 'Depth Tint', min: 0, max: 100, step: 1, suffix: '%', kf: true, group: 'depth' },
  { key: 'droVoidOpacity', label: 'Void Opacity', min: 0, max: 100, step: 1, suffix: '%', kf: true, group: 'depth' },
  { key: 'droZoomSpeed', label: 'Zoom Speed', min: -20, max: 20, step: 0.05, suffix: ' lv/s', group: 'motion' },
  { key: 'droSpinSpeed', label: 'Spin Speed', min: -180, max: 180, step: 1, suffix: '°/s', group: 'motion' },
  { key: 'droDetail', label: 'Core Detail', min: -2, max: 2, step: 0.1, kf: true, group: 'sample' },
  { key: 'droAmount', label: 'Effect Amount', min: 0, max: 100, step: 1, suffix: '%', kf: true, group: 'sample' },
];

export const DRO_ENUM_FIELDS = [
  {
    key: 'droFit',
    label: 'Fit',
    group: 'shape',
    // "Square" measures the shape against the SHORT side, so a circle stays a
    // circle on a 16:9 layer instead of becoming an ellipse.
    options: [[0, 'Layer box'], [1, 'Square']],
  },
  {
    key: 'droTiling',
    label: 'Tiling',
    group: 'spiral',
    // Mirror folds every second level, so the scale breathes instead of running
    // away. It deliberately breaks self-similarity — it is a look, not a Droste.
    options: [[0, 'Repeat'], [1, 'Mirror']],
  },
  {
    key: 'droEdge',
    label: 'Outside',
    group: 'sample',
    options: [[0, 'Transparent'], [1, 'Clamp'], [2, 'Repeat'], [3, 'Mirror']],
  },
  {
    key: 'droQuality',
    label: 'Sampling',
    group: 'sample',
    options: [[0, 'Fast'], [1, 'Smooth'], [2, 'Best']],
  },
];

export const DRO_COLOR_FIELDS = [
  { key: 'droTint', label: 'Tint', group: 'depth' },
  { key: 'droVoid', label: 'Void', group: 'depth' },
];

// Keyframable params, registered in keyframeProps.js.
export const DRO_KF_KEYS = DRO_NUMBER_FIELDS.filter((f) => f.kf).map((f) => f.key);

/* The lab's ten looks, verbatim. Each preset writes the FULL pose rather than a
   delta, so switching between them can never leave a stray knob from the last one
   — the way DS_PRESETS / REP_PRESETS already work. */
const preset = (values) => ({ ...DRO_DEFAULTS, ...values });
export const DRO_PRESETS = [
  { name: 'Infinite Frame', values: preset({ droR1: 34, droShape: 100, droFit: 0, droTwist: 0 }) },
  { name: 'Escher Spiral', values: preset({ droR1: 22, droShape: 0, droFit: 1, droTwist: 1 }) },
  { name: 'Print Gallery', values: preset({ droR1: 14, droShape: 0, droFit: 1, droTwist: 1, droSpin: -55, droFade: 8, droTintAmount: 18 }) },
  { name: 'Vortex Tunnel', values: preset({ droR1: 46, droShape: 0, droFit: 1, droTwist: 2, droFade: 26, droTintAmount: 40, droZoomSpeed: 0.3 }) },
  { name: 'Double Helix', values: preset({ droR1: 18, droShape: 0, droFit: 1, droTwist: 2 }) },
  { name: 'Reverse Spiral', values: preset({ droR1: 26, droShape: 0, droFit: 1, droTwist: -1, droZoomSpeed: 0.25, droFade: 10 }) },
  { name: 'Squircle Fall', values: preset({ droR1: 30, droShape: 46, droFit: 0, droTwist: 1, droFade: 12, droSpinSpeed: 6 }) },
  { name: 'Diamond Drop', values: preset({ droR1: 40, droShape: -100, droFit: 0, droTwist: 0, droFade: 18 }) },
  { name: 'Mirror Well', values: preset({ droR1: 52, droShape: 100, droFit: 0, droTiling: 1, droFade: 22, droZoomSpeed: 0.2 }) },
  { name: 'Three Levels Deep', values: preset({ droR1: 38, droShape: 100, droFit: 0, droDepthLimit: 3, droVoidOpacity: 100, droVoid: '#000000', droFade: 14 }) },
];

export function getDrosteEffect(item) {
  const list = Array.isArray(item?.layerEffects) ? item.layerEffects : [];
  return list.find((effect) => effect?.id === DROSTE_LAYER_EFFECT_ID) || null;
}

/* The Player's collector predicate AND the per-channel exact bypass. There is no
   "identity pose" to compare against the way Corner Pin has one — a Droste at rest
   is already recursing, which is the point — so only Effect Amount can switch it
   off, and a keyframed amount ramping up from a static 0 keeps the pass alive. */
export function isDrosteEnabled(item) {
  const effect = getDrosteEffect(item);
  if (!effect || effect.enabled === false) return false;
  const amount = Number.isFinite(effect.params?.droAmount) ? effect.params.droAmount : DRO_DEFAULTS.droAmount;
  if (amount > 0.01) return true;
  const track = item?.propertyKeyframes?.droAmount;
  return Array.isArray(track) && track.length > 0;
}

function drosteGatesRender(item) {
  if (!DRO_IS_PRO) return false;
  return isDrosteEnabled(item);
}

// Project sequences can nest other sequences, so inspect the complete saved
// editor state rather than only the currently visible timeline level.
export function containsProDrosteEffect(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  if (drosteGatesRender(value)) return true;
  if (Array.isArray(value)) return value.some((entry) => containsProDrosteEffect(entry, seen));
  return Object.values(value).some((entry) => containsProDrosteEffect(entry, seen));
}

/** Effective params for a frame: keyframe track ?? stored param ?? default. */
export function resolveDrosteParams(item, keyframeProps) {
  const effect = getDrosteEffect(item);
  const params = effect?.params || {};
  const out = {};
  for (const [key, fallback] of Object.entries(DRO_DEFAULTS)) {
    if (typeof fallback === 'string') {
      const raw = params[key];
      out[key] = typeof raw === 'string' && raw ? raw : fallback;
      continue;
    }
    const kf = keyframeProps?.[key];
    if (Number.isFinite(kf)) { out[key] = kf; continue; }
    const stored = params[key];
    out[key] = Number.isFinite(stored) ? stored : fallback;
  }
  return out;
}

/* ── shared geometry, so the panel, the on-canvas control and the shader agree ── */

/* The Shape slider is not the exponent — a linear k reads as "circle, then nothing
   happens for the top half". Geometric in k puts circle at 0, squircle in the middle
   and a true rectangle at 100 (>= 13 is where the shader switches to an exact
   max(), which is the only value that nests the box CORNERS instead of rounding
   them). Negative goes the other way, to the diamond at k = 1. */
export function drosteShapeK(shape) {
  const s = Number.isFinite(shape) ? Math.max(-100, Math.min(100, shape)) : 0;
  return s < 0 ? 1 + (s + 100) / 100 : 2 * Math.pow(8, s / 100);
}

/** Half-axis scalars of the shape, in box uv. `aspect` is the box's own w/h. */
export function drosteAxes(p, aspect) {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  let ax = 1;
  let ay = 1;
  if (Math.round(p.droFit) === 1) { ax = Math.min(1, 1 / a); ay = Math.min(1, a); }
  const stretch = Number.isFinite(p.droStretch) ? p.droStretch : 100;
  return [Math.max(1e-3, ax * (stretch / 100)), Math.max(1e-3, ay)];
}

/** The two radii, as fractions, with r2 held clear of r1 so log(r2/r1) stays finite. */
export function drosteRadii(p) {
  const r1 = Math.max(0.005, Math.min(0.99, (Number.isFinite(p.droR1) ? p.droR1 : 32) / 100));
  const r2 = Math.max((Number.isFinite(p.droR2) ? p.droR2 : 100) / 100, r1 * 1.02);
  return [r1, r2];
}

/* Superellipse "radius" of a box-uv offset — the JS twin of the shader's shapeNorm,
   used by the on-canvas control to place its rings on the SAME curve the shader
   draws. A separate implementation here would drift from the shader silently. */
export function drosteShapeNorm(dx, dy, k, ax, ay) {
  const x = Math.abs(dx / ax);
  const y = Math.abs(dy / ay);
  if (k >= 13) return Math.max(x, y);
  return Math.pow(Math.pow(x, k) + Math.pow(y, k), 1 / k);
}

/** Clip-local seconds → the animated level / spin the shader is actually given. */
export function drosteMotion(p, timeSec) {
  const t = Number.isFinite(timeSec) ? timeSec : 0;
  return {
    level: (Number.isFinite(p.droZoom) ? p.droZoom : 0) + t * (Number.isFinite(p.droZoomSpeed) ? p.droZoomSpeed : 0),
    spinDeg: (Number.isFinite(p.droSpin) ? p.droSpin : 0) + t * (Number.isFinite(p.droSpinSpeed) ? p.droSpinSpeed : 0),
  };
}

const hexToRgb = (hex) => {
  const s = typeof hex === 'string' && /^#[0-9a-f]{6}$/i.test(hex) ? hex : '#000000';
  return [parseInt(s.slice(1, 3), 16) / 255, parseInt(s.slice(3, 5), 16) / 255, parseInt(s.slice(5, 7), 16) / 255];
};

/** Tap budget per quality tier. The count is chosen per FRAGMENT from the jacobian;
    this is only the ceiling, and away from the centre almost every pixel takes one. */
export const DRO_QUALITY_TAPS = [1, 4, 16];
export const droQualityTaps = (q) => DRO_QUALITY_TAPS[Math.max(0, Math.min(2, Math.round(q) || 0))];

/* ── shader ─────────────────────────────────────────────────────────────── */

const COMMON = /* glsl */`
  uniform vec2 uOrigin;      // frame uv of the box centre
  uniform vec2 uAxisX;       // half-axis of the box in frame uv (+x)
  uniform vec2 uAxisY;       // half-axis of the box in frame uv (+y UP)

  // box uv (y down) → frame uv, through the layer-box affine
  vec2 boxToFrame(vec2 b) {
    vec2 l = vec2(b.x * 2.0 - 1.0, 1.0 - b.y * 2.0);
    return uOrigin + uAxisX * l.x + uAxisY * l.y;
  }
`;

const VERTEX = /* glsl */`
  precision highp float;
  attribute vec2 aRest;      // rest position in box uv (y down), exactly [0,1]
  varying vec2 vRest;
${COMMON}
  void main() {
    vRest = aRest;
    gl_Position = vec4(boxToFrame(aRest) * 2.0 - 1.0, 0.0, 1.0);
  }
`;

const FRAGMENT = /* glsl */`
  precision highp float;
  uniform sampler2D uTexture;
  uniform vec2 uBoxPx;       // layer box size in plate pixels
  uniform vec2 uCentre;      // box uv (y down)
  uniform float uR1, uR2;    // fractions of the shape, r2 > r1
  uniform float uK;          // superellipse exponent
  uniform float uAx, uAy;    // shape half-axes in box uv
  uniform float uTwist;      // levels per turn
  uniform float uSpin;       // radians
  uniform float uLevel;      // continuous level offset
  uniform float uFade, uTintAmount, uDepthLimit, uVoidOpacity, uDetail, uAmount;
  uniform vec3 uTint, uVoid;
  uniform int uMirror, uEdge, uMaxTaps;
  varying vec2 vRest;
${COMMON}

  const float TAU_C = 6.28318530718;
  const float GOLDEN = 2.39996322973;

  // 1.0 exactly on the shape. k = 2 circle, k >= 13 rectangle, k = 1 diamond.
  float shapeNorm(vec2 d) {
    vec2 a = abs(vec2(d.x / uAx, d.y / uAy));
    if (uK >= 13.0) return max(a.x, a.y);
    return pow(pow(a.x, uK) + pow(a.y, uK), 1.0 / uK);
  }

  // Edge handling in BOX units — the isolate is frame sized, so a texture wrap
  // mode would wrap the whole frame rather than the layer.
  vec4 fetchBox(vec2 b) {
    vec2 s = b;
    if (uEdge == 0) {
      if (s.x < 0.0 || s.x > 1.0 || s.y < 0.0 || s.y > 1.0) return vec4(0.0);
    } else if (uEdge == 1) {
      s = clamp(s, 0.0, 1.0);
    } else if (uEdge == 2) {
      s = fract(s);
    } else {
      vec2 m = mod(s, 2.0);
      s = min(m, 2.0 - m);
    }
    return texture2D(uTexture, boxToFrame(s));
  }

  /*
   * One Droste sample. jac comes back as the conformal jacobian |A|·rho'/rho,
   * which — because the source and the output share one pixel grid — IS this
   * fragment's footprint measured in source pixels. dep is how many levels below
   * the outer edge this fragment sits, measured on the OUTPUT radius so the centre
   * is always the deepest point and an animated Zoom does not drag the shading
   * around with it.
   */
  vec4 drosteSample(vec2 b, out float jac, out float dep, out float depCut, out float rhoOut) {
    vec2 q = (b - uCentre) * 2.0;
    float rho = max(shapeNorm(q), 1e-7);
    rhoOut = rho;
    float th = atan(q.y, q.x);

    float LN1 = log(uR1);
    float LN2 = log(uR2);
    float L = max(LN2 - LN1, 1e-4);

    float u = log(rho);
    float v = th;

    // The twist: one complex multiply by A = 1 - i*c. The second line is what
    // keeps the map conformal; without it this is a shear and the artwork squashes.
    float c = uTwist * L / TAU_C;
    float up = u + c * v;
    float vp = v - c * u;

    up += uLevel * L;
    vp += uSpin;

    // Fold the scale axis into a single period. This one line IS the recursion.
    float lu = (up - LN1) / L;
    float fl = floor(lu);
    // (lu is read again below for depCut — keep it in scope.)
    float fr = lu - fl;
    if (uMirror == 1 && mod(fl, 2.0) > 0.5) fr = 1.0 - fr;

    float rp = exp(LN1 + fr * L);
    vec2 dir = vec2(cos(vp), sin(vp));
    vec2 qp = dir * (rp / max(shapeNorm(dir), 1e-7));

    jac = sqrt(1.0 + c * c) * rp / rho;
    dep = max(0.0, (LN2 - u) / L);
    /*
     * The COPY index — which copy of the stack this fragment belongs to.
     *
     * It carries uLevel, so it moves WITH the stack: copy 2 stays copy 2 while
     * the zoom flies through it. That is what makes a finite count literal
     * rather than a window that content streams through.
     *
     * "dep" above is the same measure WITHOUT uLevel and without the twist. The
     * shading uses that one on purpose: a depth fade should stay radial and stay
     * put, so the centre is always the deepest point and a looping zoom does not
     * drag the darkening around with it.
     */
    depCut = 1.0 - lu;
    return fetchBox(uCentre + qp * 0.5);
  }

  void main() {
    vec2 b = vRest;
    vec2 px = 1.0 / max(uBoxPx, vec2(1.0));

    float jac = 1.0;
    float dep = 0.0;
    float depCut = 0.0;
    float rho = 1.0;
    vec4 acc = drosteSample(b, jac, dep, depCut, rho);

    /*
     * Adaptive supersampling. Because the map MAGNIFIES by jac, taps spread
     * across one output pixel already cover the whole source footprint — so the
     * count, not the spread, is what has to follow it. Most of the frame sits at
     * jac ≈ 1 and takes the single tap above; only the core pays.
     */
    int taps = 1;
    if (uMaxTaps > 1) taps = int(clamp(ceil(jac * 1.5), 1.0, float(uMaxTaps)));
    if (taps > 1) {
      float n = float(taps);
      for (int i = 1; i < 16; i++) {
        if (i >= taps) break;
        float fi = float(i) + 0.5;
        float rr = sqrt(fi / n) * 0.5;
        float aa = fi * GOLDEN;
        float j2, d2, dc2, r2;
        acc += drosteSample(b + vec2(cos(aa), sin(aa)) * rr * px, j2, d2, dc2, r2);
      }
      acc /= n;
    }

    /*
     * Past what the tap budget can average, the recursion is finer than the raster
     * and the honest answer is to stop drawing it rather than to alias it. The
     * region this removes is a few pixels across by construction — Core Detail
     * moves the threshold if you would rather have the shimmer.
     */
    float cut = 3.0 * float(uMaxTaps) * pow(2.0, uDetail);
    float keep = 1.0 - smoothstep(cut, cut * 3.0, jac);

    /*
     * A finite copy count cuts ON the level boundary, not near it. "dep" is the
     * level index measured on the output radius, so Copies = 3 means "keep
     * dep < 3" — three nested copies and then the void. The feather is ONE PIXEL
     * wide, derived analytically (d(dep)/d(pixel) = 2 / (L * rho * boxPx)) rather
     * than as a fixed fraction of a level: levels compress geometrically toward
     * the centre, so a fixed feather is invisible at the outside and swallows
     * whole copies near the middle.
     */
    /*
     * A FINITE STACK, not a window onto an endless one. Both ends are bounded,
     * and the second bound is the one that was missing.
     *
     * The fold is periodic: it will happily manufacture a copy at any depth,
     * outward as well as inward. Cutting only the inner end therefore capped
     * nothing once the zoom ran - the stack slid outward, the fold produced
     * fresh copies behind it at the outer end, and "3 copies" became however
     * many the frame could hold. Cutting only the outer end (measured on the
     * screen instead of on the stack) capped the COUNT but pinned the rim to
     * the frame, so the copies streamed through a hole that never moved.
     *
     * Bounding both ends of a stack that MOVES gives what a count should mean:
     * set 3 and there are three copies, they are the same three, and the zoom
     * flies through them and out the other side. It does not loop - a finite
     * stack cannot - so Copies 0 remains the setting for an endless zoom.
     */
    if (uDepthLimit > 0.5) {
      float lvl = max(log(uR2) - log(uR1), 1e-4);
      float fw = 2.0 / max(lvl * rho * min(uBoxPx.x, uBoxPx.y), 1e-3);
      // past the bottom of the stack
      keep *= 1.0 - smoothstep(uDepthLimit - fw, uDepthLimit + fw, depCut);
      // past the top of it. The stack runs OUTWARD as far as it runs inward, so
      // the copies are distributed both ways around the layer rather than only
      // nesting inside it. At rest this costs nothing and changes nothing: an
      // outward copy is bigger than the outer radius, so it sits outside the box
      // entirely. It is what fills the frame once a zoom carries the stack out,
      // instead of the frame simply emptying.
      keep *= smoothstep(-uDepthLimit - fw, -uDepthLimit + fw, depCut);
    }

    // Depth shading, on the premultiplied isolate.
    if (uTintAmount > 0.0) {
      float k = clamp(uTintAmount * (1.0 - exp(-dep * 0.65)), 0.0, 1.0);
      acc.rgb = mix(acc.rgb, uTint * acc.a, k);
    }
    if (uFade > 0.0) acc.rgb *= pow(max(1.0 - uFade, 0.0), dep);
    acc = mix(vec4(uVoid * uVoidOpacity, uVoidOpacity), acc, keep);

    gl_FragColor = uAmount >= 0.999 ? acc : mix(fetchBox(b), acc, uAmount);
  }
`;

export function createDrostePass() {
  const geometry = new THREE.BufferGeometry();
  // No overscan: the fold resolves every point inside the box, and a Droste
  // resamples the layer rather than displacing it past its own bounds.
  const rest = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(4 * 3), 3));
  geometry.setAttribute('aRest', new THREE.BufferAttribute(rest, 2));
  geometry.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 2, 1, 0, 3, 2]), 1));

  const material = new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,          // a mirrored layer flips the quad's winding
    blending: THREE.CustomBlending,  // the isolate is premultiplied
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    uniforms: {
      uTexture: { value: null },
      uOrigin: { value: new THREE.Vector2(0.5, 0.5) },
      uAxisX: { value: new THREE.Vector2(0.5, 0) },
      uAxisY: { value: new THREE.Vector2(0, 0.5) },
      uBoxPx: { value: new THREE.Vector2(1920, 1080) },
      uCentre: { value: new THREE.Vector2(0.5, 0.5) },
      uR1: { value: 0.32 },
      uR2: { value: 1 },
      uK: { value: 16 },
      uAx: { value: 1 },
      uAy: { value: 1 },
      uTwist: { value: 0 },
      uSpin: { value: 0 },
      uLevel: { value: 0 },
      uFade: { value: 0 },
      uTintAmount: { value: 0 },
      uDepthLimit: { value: 0 },
      uVoidOpacity: { value: 0 },
      uDetail: { value: 0 },
      uAmount: { value: 1 },
      uTint: { value: new THREE.Vector3(0, 0, 0) },
      uVoid: { value: new THREE.Vector3(0, 0, 0) },
      uMirror: { value: 0 },
      uEdge: { value: 0 },
      uMaxTaps: { value: 4 },
    },
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(mesh);
  return { scene, mesh, geometry, material };
}

export function applyDrosteUniforms(material, p, box, timeSec = 0) {
  const u = material.uniforms;
  u.uOrigin.value.set(box.origin[0], box.origin[1]);
  u.uAxisX.value.set(box.axisX[0], box.axisX[1]);
  u.uAxisY.value.set(box.axisY[0], box.axisY[1]);
  const boxW = Math.max(1, box.sizePx[0]);
  const boxH = Math.max(1, box.sizePx[1]);
  u.uBoxPx.value.set(boxW, boxH);
  u.uCentre.value.set(p.droCX / 100, p.droCY / 100);

  const [r1, r2] = drosteRadii(p);
  u.uR1.value = r1;
  u.uR2.value = r2;
  u.uK.value = drosteShapeK(p.droShape);
  const [ax, ay] = drosteAxes(p, boxW / boxH);
  u.uAx.value = ax;
  u.uAy.value = ay;

  const motion = drosteMotion(p, timeSec);
  u.uTwist.value = p.droTwist;
  u.uSpin.value = (motion.spinDeg * Math.PI) / 180;
  u.uLevel.value = motion.level;

  u.uFade.value = Math.max(0, Math.min(0.9, p.droFade / 100));
  u.uTintAmount.value = Math.max(0, Math.min(1, p.droTintAmount / 100));
  u.uDepthLimit.value = Math.max(0, p.droDepthLimit);
  u.uVoidOpacity.value = Math.max(0, Math.min(1, p.droVoidOpacity / 100));
  u.uDetail.value = Math.max(-2, Math.min(2, p.droDetail));
  u.uAmount.value = Math.max(0, Math.min(1, p.droAmount / 100));
  const tint = hexToRgb(p.droTint);
  const nul = hexToRgb(p.droVoid);
  u.uTint.value.set(tint[0], tint[1], tint[2]);
  u.uVoid.value.set(nul[0], nul[1], nul[2]);
  u.uMirror.value = Math.round(p.droTiling) === 1 ? 1 : 0;
  u.uEdge.value = Math.max(0, Math.min(3, Math.round(p.droEdge)));
  u.uMaxTaps.value = droQualityTaps(p.droQuality);
}
