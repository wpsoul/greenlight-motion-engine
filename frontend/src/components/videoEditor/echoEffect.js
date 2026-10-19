/*
 * Echo — After Effects' Echo, as an Overlay Effect. Ported from
 * html/echo-lab.html (the lab is the source of truth for the operator maths and
 * for every default in here; tune there first).
 *
 * WHY THIS IS NOT AN ORDINARY REGISTRY ENTRY. Every other effect in
 * adjustmentEffects.js is a `fx(uv)` body over one plate. Echo is TEMPORAL: it
 * needs N images taken at N different times, folded together in order. So the
 * descriptor carries `temporal: 'echo'` and Player.renderEchoStack owns the
 * pipeline, the same way the declarative `passes` family hands its walk to
 * runEffectChain. The descriptor still ships a pass-through `fragment` so that a
 * build which somehow reaches the material path renders a no-op rather than
 * throwing.
 *
 * ── THE TWO ENGINES, AND THE ONE THING THE APP CHANGES ──────────────────────
 *
 * The lab compared a ring of recorded frames against re-rendering its scene at
 * every echo time. The ring ports verbatim. The re-render does NOT: the lab's
 * scene was procedural, so it could be evaluated at any instant, and neither a
 * decoded video frame nor a finished composite can be. What the app CAN
 * evaluate at any instant is the layer's POSE — the same boxAtTime() Motion
 * Trail reprojects with — so the second engine re-poses the current plate
 * instead of re-rendering it.
 *
 * That leaves the two engines genuinely complementary rather than one being a
 * cheap copy of the other:
 *
 *   FRAME HISTORY  real pixels, so it carries motion from INSIDE the footage —
 *                  a talking head, a video, a whole composite below an
 *                  adjustment layer. Past only (there is no recording of a
 *                  frame that has not happened), quantised to the 30fps grid,
 *                  bounded by the ring, and stored at reduced resolution.
 *
 *   ANALYTIC       the pose evaluated at the exact time asked for. Sub-frame
 *                  spacing, POSITIVE echo times (echoes that lead the layer),
 *                  no capacity ceiling and no seek cost — but it moves the
 *                  CURRENT pixels, so it cannot show internal motion. Needs a
 *                  layer box, so it is layer scope only; in adjustment scope
 *                  the effect falls back to Frame History (there is no single
 *                  pose for "everything below").
 *
 * ── ALPHA ───────────────────────────────────────────────────────────────────
 * The chain's plates are PREMULTIPLIED, which is what makes the AE operator set
 * one-liners: over/add/screen are all linear there and a transparent pixel is
 * exactly zero, so it cannot tint its neighbours. Intensity is a plain multiply
 * (AE applies it as opacity), and the accumulator re-clamps rgb <= a after every
 * fold so no pass can leave an invalid premultiplied colour behind.
 */
export const ECHO_EFFECT_ID = 'echo';

// 0 = a ring of recorded plates; 1 = the current plate re-posed at each echo time.
export const ECHO_ENGINE_HISTORY = 0;
export const ECHO_ENGINE_ANALYTIC = 1;

// AE's Echo Operator, in AE's own order of usefulness rather than AE's menu
// order. Composite In Back is the default because it is the one that reads as a
// trail; it is also the only one that maps onto Motion Trail's "Behind".
export const ECHO_OP_ADD = 0;
export const ECHO_OP_SCREEN = 1;
export const ECHO_OP_MAX = 2;
export const ECHO_OP_MIN = 3;
export const ECHO_OP_BACK = 4;
export const ECHO_OP_FRONT = 5;
export const ECHO_OP_BLEND = 6;

// Hard ceiling on images. Each one costs a warp + a fold at full plate size, and
// raising it is a performance decision, not a slider edit.
export const ECHO_MAX_TAPS = 32;
// Ring capacity ceiling, in nominal frames. 64 half-res 1080p slots is ~59 MB.
export const ECHO_RING_MAX = 64;
// The nominal timeline frame the ring is keyed in. Fixed at 30 for the same
// reason Motion Trail fixes it: a 24fps export and a 60fps preview must build
// the same echo, so the grid cannot follow the real frame rate.
export const ECHO_FRAME_DT = 1 / 30;

// An image below this cannot move an 8-bit target, so the stack stops there
// rather than spending two passes to add nothing.
export const ECHO_MIN_WEIGHT = 0.002;

// The identity box: the whole frame, in the uv space computeLayerBox reports in.
// Adjustment scope has no layer, and every warp through this pair is a straight
// copy — which is exactly what "echo the finished composite" means.
export const ECHO_IDENTITY_BOX = Object.freeze({
  origin: [0.5, 0.5],
  axisX: [0.5, 0],
  axisY: [0, 0.5],
});

/*
 * The registry param list. Exported rather than inlined into the descriptor so
 * the planner below and the panel agree on ranges by construction.
 *
 * `slot` is required by applyEffectUniforms even though Echo's own materials do
 * not read uParams — the shared uniform writer walks every numeric param.
 * `static: true` keeps the two ring-shape controls off keyframe tracks: they
 * decide an ALLOCATION, and animating an allocation just thrashes it.
 */
export const ECHO_PARAMS = [
  {
    key: 'engine', slot: 0, label: 'Engine', type: 'select', primary: true, default: ECHO_ENGINE_HISTORY,
    options: [
      { value: ECHO_ENGINE_HISTORY, label: 'Frame History (real pixels)' },
      { value: ECHO_ENGINE_ANALYTIC, label: 'Analytic (any time)' },
    ],
  },
  // AE's default is one frame at 30fps. Negative trails behind, positive leads —
  // the sign convention is AE's, and the panel says so.
  { key: 'echoTime', slot: 1, label: 'Echo Time', min: -0.5, max: 0.5, step: 0.005, default: -0.0333, suffix: 's' },
  { key: 'count', slot: 2, label: 'Echoes', min: 0, max: ECHO_MAX_TAPS, step: 1, default: 8 },
  { key: 'intensity', slot: 3, label: 'Start Intensity', min: 0, max: 200, step: 1, default: 100, suffix: '%' },
  { key: 'decay', slot: 4, label: 'Decay', min: 0, max: 120, step: 1, default: 86, suffix: '%' },
  {
    key: 'operator', slot: 5, label: 'Operator', type: 'select', default: ECHO_OP_BACK,
    options: [
      { value: ECHO_OP_BACK, label: 'Composite In Back' },
      { value: ECHO_OP_FRONT, label: 'Composite In Front' },
      { value: ECHO_OP_ADD, label: 'Add' },
      { value: ECHO_OP_SCREEN, label: 'Screen' },
      { value: ECHO_OP_MAX, label: 'Maximum' },
      { value: ECHO_OP_MIN, label: 'Minimum' },
      { value: ECHO_OP_BLEND, label: 'Blend' },
    ],
  },
  { key: 'colorize', slot: 6, label: 'Colorize', min: 0, max: 100, step: 1, default: 0, suffix: '%' },
  { key: 'tint', type: 'color', label: 'Tint', default: '#4fd6ff' },
  {
    key: 'capacity', slot: 7, label: 'Ring', min: 4, max: ECHO_RING_MAX, step: 1, default: 24,
    suffix: 'f', static: true, showIf: { key: 'engine', equals: ECHO_ENGINE_HISTORY },
  },
  {
    key: 'resolution', slot: 8, label: 'Ring Res', type: 'select', default: 50, static: true,
    showIf: { key: 'engine', equals: ECHO_ENGINE_HISTORY },
    options: [
      { value: 100, label: 'Full' },
      { value: 50, label: 'Half' },
      { value: 25, label: 'Quarter' },
    ],
  },
];

/*
 * The image stack, as data. Both engines walk the SAME list — they differ only
 * in where the pixels for entry i come from — which is what keeps the two
 * engines comparable instead of two separate looks that happen to share a name.
 *
 * Entry 0 is the live plate at Starting Intensity; AE counts `count` echoes IN
 * ADDITION to it, so the list is count + 1 long before the weight cutoff.
 */
export function planEchoTaps(params) {
  const count = Math.max(0, Math.min(ECHO_MAX_TAPS, Math.round(params.count ?? 0)));
  const start = Math.max(0, (params.intensity ?? 100) / 100);
  const decay = Math.max(0, (params.decay ?? 86) / 100);
  const echoTime = Number.isFinite(params.echoTime) ? params.echoTime : 0;
  const taps = [];
  for (let i = 0; i <= count; i++) {
    const weight = start * Math.pow(decay, i);
    if (i > 0 && weight < ECHO_MIN_WEIGHT) break;
    taps.push({
      index: i,
      dt: i * echoTime,
      weight,
      // Colorize ramps 0 → full across the stack, so the tail cools toward the
      // tint and the live image is never tinted.
      depth: count > 0 ? i / count : 0,
    });
  }
  return taps;
}

/** Ring slot size for a plate. Half res by default — an echo ghost is soft. */
export function echoRingSize(width, height, resolutionPct) {
  const scale = Math.max(0.05, Math.min(1, (resolutionPct || 50) / 100));
  return {
    width: Math.max(8, Math.round(width * scale)),
    height: Math.max(8, Math.round(height * scale)),
  };
}

/*
 * Everything that invalidates recorded pixels: a resize, a different ring shape,
 * or a scope change. Params that only affect the FOLD (operator, decay, tint)
 * are deliberately absent — re-tinting a stack must not throw the history away.
 */
export function echoRingSignature(width, height, params) {
  return `${width}x${height}|${Math.round(params.capacity)}|${Math.round(params.resolution)}`;
}
