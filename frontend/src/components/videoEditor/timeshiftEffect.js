/*
 * TimeShift — the ARRI TSB (Timing Shift Box), as an Overlay Effect. Ported from
 * html/timeshift-lab.html; the lab is the source of truth for the model and for
 * every default in here, so tune there first.
 *
 * ── WHAT THE BOX DOES ───────────────────────────────────────────────────────
 * The TSB shifts the PHASE between the shutter and the film movement, so the
 * shutter is still open while the pulldown claw is dragging the film through the
 * gate. One exposure is therefore the picture SLIDING PAST THE GATE rather than
 * sitting still in it — which is why the look is a streak and not a blur, and why
 * it runs along the film path.
 *
 * The frame-displacement half of the look falls out of the same geometry: the
 * along-axis coordinate IS the position of the film in the gate, so travelling
 * past ±half a pitch means the gate is now looking at the NEIGHBOURING FRAME.
 * Spatial distance turns into distance in TIME. That is the whole reason this
 * cannot be a spatial motion blur — a motion blur has no other frame to reach for.
 *
 * ── WHY IT IS TEMPORAL, AND WHY IT IS NOT SHAPED LIKE ECHO ──────────────────
 * Like Echo it carries `temporal:` and Player.renderTimeShift owns the pipeline;
 * the descriptor still ships a pass-through fragment so a build that somehow
 * reaches the material path is a no-op rather than a throw.
 *
 * But Echo's taps all share ONE offset for the whole frame, so it can bind one
 * history slot at a time and spend a warp plus a fold per tap — 2T + 2 draw
 * calls. Here the offset varies PER PIXEL, which is the entire effect, so the
 * shader has to reach an arbitrary slot on every texture read. At the 24–48
 * samples a smooth streak needs, Echo's shape would be 50–98 draw calls a frame.
 *
 * So the ring is a single ATLAS — one render target subdivided into a tile grid,
 * one tile per slot — read with a computed tile offset. One draw call, T reads.
 * An array texture would be the textbook answer; an atlas was chosen because it
 * needs no API that WebGL and WebGPU could disagree about, and in this codebase a
 * WebGPU disagreement is a SILENT no-op rather than an error.
 *
 * ── WHY A HALF-RES RING IS NEARLY FREE HERE ─────────────────────────────────
 * In Echo only the echoes come from the ring, so a reduced ring softens only the
 * ghosts. Here the shifted region is the PICTURE, so the same trick would soften
 * most of the frame. The fix is that the newest slot is never read from the
 * atlas at all: a sample less than one frame back is served from the full-res
 * plate, which is the same image at full resolution. Most of the fan sits there,
 * and the deeper taps that do come from the atlas are heavily streaked anyway —
 * so their softness is invisible. That is what makes Half the sane default.
 *
 * ── THE RING IS SHALLOW, AND THAT IS THE POINT ──────────────────────────────
 * A streak only reaches back `ceil(shift) + shutter` frames — about 3 at the
 * defaults, never more than TIMESHIFT_DEPTH_MAX. Echo needs 24–64 slots because a
 * trail is long in TIME; this is long in SPACE and shallow in time. That is what
 * keeps a full-resolution atlas affordable.
 *
 * ── TWO THINGS FROM THE LAB THAT DELIBERATELY DID NOT PORT ──────────────────
 * `Source oversample` and the strobe. Both need the source evaluated at sub-frame
 * times, which the lab could do because its scenes were procedural. A composited
 * plate cannot be re-rendered at a time between frames, so both are lab-only
 * affordances rather than features that were dropped.
 */
export const TIMESHIFT_EFFECT_ID = 'timeshift';

// Film travel. The picture streaks AGAINST the direction of travel, because the
// gate sees the film sliding through it.
export const TS_TRAVEL_DOWN = 0;
export const TS_TRAVEL_UP = 1;
export const TS_TRAVEL_RIGHT = 2;
export const TS_TRAVEL_LEFT = 3;

/*
 * Bearings on the uv plane for each travel direction, in degrees.
 *
 * The shader's uv comes from gl_FragCoord, whose origin is BOTTOM-left, so uv.y
 * grows UPWARD — and yet Down is +y here, which looks wrong and is not. A sample
 * reads the source at `uv + t*dir`, so an object at q appears at `q - t*dir`:
 * the streak extends along MINUS dir. With dir = +y (up in uv), the tail runs
 * down the screen, which is what "the film travelled down" should look like.
 *
 * Measured, not reasoned: tests/timeshift-app moves the luminance centroid
 * +45px for Down and -35px for Up on a 360px frame, +ve being toward the bottom.
 */
export const TS_TRAVEL_DEG = Object.freeze({
  [TS_TRAVEL_DOWN]: 0,
  [TS_TRAVEL_UP]: 180,
  [TS_TRAVEL_RIGHT]: 90,
  [TS_TRAVEL_LEFT]: 270,
});

// The qualifier. Restricting the streak is closer to the real thing than
// smearing everything: on film it is only the badly over-exposed highlights that
// streak while the rest of the frame stays sharp.
export const TS_RANGE_OFF = 0;
export const TS_RANGE_LUMA = 1;
export const TS_RANGE_COLOUR = 2;

// Hard ceiling on samples. Each one is a texture read, not a pass, so this is a
// bandwidth decision rather than a draw-call one — but a 48-tap fan at 1080p is
// already 100M texel fetches a frame.
export const TS_MAX_SAMPLES = 48;

// Ring capacity ceiling, in nominal frames. Deliberately small: see the header.
export const TS_RING_MAX = 16;

// The deepest the streak is ever allowed to reach, in frames. Caps the ring the
// shader can ask for so a wild `shift` cannot demand an unbounded history.
export const TIMESHIFT_DEPTH_MAX = 12;

/*
 * The nominal timeline frame the ring is keyed in. Fixed at 30 for exactly the
 * reason Echo and Motion Trail fix it: a 24fps export and a 60fps preview must
 * build the SAME streak, so the grid cannot follow the real frame rate. It is
 * also what makes "crossing one frame pitch = one frame back" a stable claim.
 */
export const TIMESHIFT_FRAME_DT = 1 / 30;

/*
 * The largest atlas edge we will ask a GPU for. WebGL2 only guarantees 2048, but
 * every device this app targets reports >= 4096 and the pass pool has no way to
 * renegotiate a failed allocation. The scale is reduced to fit rather than the
 * capacity, because losing history changes the LOOK while losing resolution only
 * softens it.
 */
export const TS_ATLAS_MAX = 4096;

/*
 * The registry param list. `slot` is required by applyEffectUniforms even though
 * this effect's material does not read uParams — the shared uniform writer walks
 * every numeric param. uParams is float[28] with 24-27 reserved, so slots must
 * stay under 24.
 *
 * `static: true` keeps a control off keyframe tracks. Here that is the three that
 * decide an ALLOCATION or a cost (samples, capacity, resolution) — animating an
 * allocation just thrashes it.
 *
 * There is deliberately no `kf:` flag on anything. That is a LAYER-effect
 * convention (autoFillLayer, bezierWarp); an Overlay Effect's keyframing is
 * generic — runEffectChain walks every non-static numeric param and looks for a
 * `fx:<eid>:<key>` track — so every number here is already animatable and a `kf`
 * flag would only imply a mechanism that nothing on this path reads.
 */
export const TIMESHIFT_PARAMS = [
  // The hand wheel. Measured in frame PITCHES: one pitch is the frame's extent
  // along whichever axis the film runs, so the same value is a longer streak
  // sideways than vertically. That asymmetry is real and is not normalised away.
  {
    key: 'shift', slot: 0, label: 'Shift', min: 0, max: 2, step: 0.005,
    default: 0.3, primary: true,
  },
  {
    key: 'travel', slot: 1, label: 'Film Travel', type: 'select', primary: true,
    default: TS_TRAVEL_DOWN,
    options: [
      { value: TS_TRAVEL_DOWN, label: 'Down' },
      { value: TS_TRAVEL_UP, label: 'Up' },
      { value: TS_TRAVEL_RIGHT, label: 'Right' },
      { value: TS_TRAVEL_LEFT, label: 'Left' },
    ],
  },
  { key: 'angle', slot: 2, label: 'Angle', min: -30, max: 30, step: 0.5, default: 0, suffix: '°' },
  // The box's own jitter function: it randomises the STREAK LENGTH frame to
  // frame, which is what keeps the mechanical version from looking looped.
  { key: 'jitter', slot: 3, label: 'Jitter', min: 0, max: 100, step: 1, default: 10, suffix: '%' },
  // How long the gate is open, so it trades streak length against how much
  // subject motion the streak carries.
  { key: 'shutter', slot: 4, label: 'Shutter Angle', min: 11.25, max: 360, step: 1.25, default: 180, suffix: '°' },
  { key: 'samples', slot: 5, label: 'Samples', min: 4, max: TS_MAX_SAMPLES, step: 1, default: 24, static: true },
  { key: 'falloff', slot: 6, label: 'Shutter Ramp', min: 0, max: 100, step: 1, default: 50, suffix: '%' },
  {
    key: 'wrap', slot: 7, label: 'Cross Frame Line', type: 'select', default: 1,
    options: [
      { value: 1, label: 'On (frame displacement)' },
      { value: 0, label: 'Off (clamp at edge)' },
    ],
  },
  // The unexposed strip between frames, riding along in the smear — which is why
  // it reads as a soft dark streak and never as a hard bar.
  { key: 'gap', slot: 8, label: 'Gate Gap', min: 0, max: 100, step: 1, default: 0, suffix: '%' },

  {
    key: 'range', slot: 9, label: 'Restrict To', type: 'select', default: TS_RANGE_OFF,
    options: [
      { value: TS_RANGE_OFF, label: 'Everything streaks' },
      { value: TS_RANGE_LUMA, label: 'Luma window' },
      { value: TS_RANGE_COLOUR, label: 'Colour' },
    ],
  },
  {
    key: 'rangeLo', slot: 10, label: 'Low', min: 0, max: 100, step: 1, default: 62, suffix: '%',
    showIf: { key: 'range', equals: TS_RANGE_LUMA },
  },
  {
    key: 'rangeHi', slot: 11, label: 'High', min: 0, max: 100, step: 1, default: 100, suffix: '%',
    showIf: { key: 'range', equals: TS_RANGE_LUMA },
  },
  {
    key: 'rangeHue', slot: 12, label: 'Hue', min: 0, max: 360, step: 1, default: 40, suffix: '°',
    showIf: { key: 'range', equals: TS_RANGE_COLOUR },
  },
  {
    key: 'rangeHueW', slot: 13, label: 'Hue Width', min: 2, max: 180, step: 1, default: 40, suffix: '°',
    showIf: { key: 'range', equals: TS_RANGE_COLOUR },
  },
  {
    key: 'rangeSat', slot: 14, label: 'Min Saturation', min: 0, max: 100, step: 1, default: 25, suffix: '%',
    showIf: { key: 'range', equals: TS_RANGE_COLOUR },
  },
  // Up to 100%: at the top of the range the luma window's transition spans the
  // whole 0..1 scale and the hue falloff spans a full 180 degrees, so the key
  // stops being a window at all and becomes a gradient. The mask then never
  // reaches 1 anywhere, which is a legitimate look (everything streaks a
  // little) and costs nothing structurally — `keep` is always 1 - mask, so the
  // split stays lossless at any softness.
  { key: 'rangeSoft', slot: 15, label: 'Range Softness', min: 0, max: 100, step: 1, default: 12, suffix: '%' },
  {
    key: 'rangeInvert', slot: 16, label: 'Invert Range', type: 'select', default: 0,
    options: [{ value: 0, label: 'No' }, { value: 1, label: 'Yes' }],
  },

  // A streak spreads a fixed amount of light over a longer path, so it dims as it
  // lengthens. That is physically right and on its own it turns every streak to
  // grey mush, because the real thing is shot on highlights many stops over
  // clipping which streak WITHOUT dimming. Headroom is that: samples are expanded
  // before they are summed and compressed after.
  { key: 'gain', slot: 17, label: 'Gain', min: 20, max: 400, step: 1, default: 100, suffix: '%' },
  { key: 'headroom', slot: 18, label: 'Highlight Headroom', min: 0, max: 99, step: 1, default: 97, suffix: '%' },

  {
    key: 'capacity', slot: 19, label: 'Ring', min: 3, max: TS_RING_MAX, step: 1, default: 8,
    suffix: 'f', static: true,
  },
  {
    key: 'resolution', slot: 20, label: 'Ring Res', type: 'select', default: 50, static: true,
    options: [
      { value: 100, label: 'Full' },
      { value: 50, label: 'Half' },
      { value: 25, label: 'Quarter' },
    ],
  },
];

/*
 * How deep the streak actually reaches, in nominal frames.
 *
 * A sample at fan position u reads `u * shutterFrames + |k|` frames back, where k
 * is the number of frame boundaries its travel crossed. Travel runs from the
 * pixel's own along-axis position (worst case ±0.5) plus `shift`, so the deepest
 * |k| any pixel can hit is floor(|shift| + 0.5) + 1.
 *
 * This is what sizes the ring, and clamping it here is what stops a wild `shift`
 * from demanding an unbounded history.
 */
export function timeshiftDepth(params) {
  const shift = Math.abs(Number.isFinite(params?.shift) ? params.shift : 0);
  const shutterFrames = Math.max(0, (params?.shutter ?? 180) / 360);
  const wrap = Math.round(params?.wrap ?? 1) === 1;
  const crossings = wrap ? Math.floor(shift + 0.5) + 1 : 0;
  return Math.min(TIMESHIFT_DEPTH_MAX, Math.ceil(crossings + shutterFrames));
}

/*
 * The jitter function, seeded on the frame index so a seek lands on the same
 * dice and a re-render of the same frame is identical. Shortens the streak only
 * — the wheel setting is the maximum, the way the mechanical stop is.
 */
export function timeshiftJitterAt(frameIdx, params) {
  const jitter = Math.max(0, Math.min(1, (params?.jitter ?? 0) / 100));
  const shift = Number.isFinite(params?.shift) ? params.shift : 0;
  if (jitter <= 0) return shift;
  const s = Math.sin(frameIdx * 2.71 + 5.1) * 43758.5453123;
  const r = s - Math.floor(s);
  return shift * (1 - jitter * r);
}

/*
 * Atlas geometry for a plate: a tile grid big enough for `capacity` slots.
 *
 * The grid is kept near-square so neither edge runs away, and if the result would
 * exceed TS_ATLAS_MAX the SCALE is reduced rather than the capacity — losing
 * history changes the look, losing resolution only softens it. `scale` is
 * returned so the caller can report what it actually got.
 */
export function timeshiftAtlas(width, height, resolutionPct, capacity, maxEdge) {
  const cap = Math.max(3, Math.min(TS_RING_MAX, Math.round(capacity || 8)));
  const cols = Math.ceil(Math.sqrt(cap));
  const rows = Math.ceil(cap / cols);
  const want = Math.max(0.05, Math.min(1, (resolutionPct || 50) / 100));
  // The real device limit when the caller knows it (renderer.capabilities), not
  // a guess. A guessed ceiling either wastes resolution on a desktop GPU or asks
  // for an allocation the pass pool has no way to renegotiate on a small one.
  const lim = Math.max(1024, Math.min(16384, Math.round(maxEdge || TS_ATLAS_MAX)));
  const fit = Math.min(
    1,
    lim / Math.max(1, cols * width * want),
    lim / Math.max(1, rows * height * want),
  );
  const scale = want * fit;
  const tileW = Math.max(8, Math.floor(width * scale));
  const tileH = Math.max(8, Math.floor(height * scale));
  return {
    cap, cols, rows, tileW, tileH, scale,
    atlasW: cols * tileW,
    atlasH: rows * tileH,
    // Bytes, for the perf read-out. RGBA8.
    bytes: cols * tileW * rows * tileH * 4,
  };
}

/*
 * Everything that invalidates recorded pixels: a resize or a different ring
 * shape. Params that only affect the READ (shift, shutter, range, gain) are
 * deliberately absent — re-tuning the look must not throw the history away, or
 * every slider drag would restart the ring and flash.
 */
export function timeshiftRingSignature(width, height, params, maxEdge) {
  const a = timeshiftAtlas(width, height, params?.resolution, params?.capacity, maxEdge);
  return `${width}x${height}|${a.cols}x${a.rows}|${a.tileW}x${a.tileH}`;
}

/*
 * Everything the shader needs, derived once on the CPU so the material stays a
 * pure function of its uniforms.
 *
 * `dir` is a unit bearing on the uv plane. The wrap happens at ±0.5 along it, so
 * one pitch is the frame's extent along THAT axis — which is why a sideways pull
 * is a longer streak in pixels than a vertical one at the same wheel setting.
 */
export function timeshiftPlan(params, frameIdx) {
  const travel = Math.round(params?.travel ?? TS_TRAVEL_DOWN);
  const baseDeg = TS_TRAVEL_DEG[travel] ?? 0;
  const deg = baseDeg + (Number.isFinite(params?.angle) ? params.angle : 0);
  const rad = (deg * Math.PI) / 180;
  const samples = Math.max(2, Math.min(TS_MAX_SAMPLES, Math.round(params?.samples ?? 24)));
  return {
    shift: timeshiftJitterAt(frameIdx, params),
    dirX: Math.sin(rad),
    dirY: Math.cos(rad),
    shutterFrames: Math.max(0, (params?.shutter ?? 180) / 360),
    samples,
    falloff: Math.max(0, Math.min(1, (params?.falloff ?? 50) / 100)),
    wrap: Math.round(params?.wrap ?? 1) === 1 ? 1 : 0,
    gap: Math.max(0, Math.min(1, (params?.gap ?? 0) / 100)),
    gain: Math.max(0, (params?.gain ?? 100) / 100),
    // Clamped below 1 so expand()'s denominator cannot reach zero.
    headroom: Math.max(0, Math.min(0.99, (params?.headroom ?? 97) / 100)),
    range: Math.round(params?.range ?? TS_RANGE_OFF),
    rangeLo: Math.max(0, Math.min(1, (params?.rangeLo ?? 62) / 100)),
    rangeHi: Math.max(0, Math.min(1, (params?.rangeHi ?? 100) / 100)),
    rangeSoft: Math.max(0, Math.min(1, (params?.rangeSoft ?? 12) / 100)),
    rangeHue: Number.isFinite(params?.rangeHue) ? params.rangeHue : 40,
    rangeHueW: Number.isFinite(params?.rangeHueW) ? params.rangeHueW : 40,
    rangeSat: Math.max(0, Math.min(1, (params?.rangeSat ?? 25) / 100)),
    rangeInvert: Math.round(params?.rangeInvert ?? 0) === 1 ? 1 : 0,
  };
}

/*
 * An exact bypass. `shift` 0 with the shutter closed is the identity — every
 * sample lands on the current frame at its own uv — so the whole pipeline can be
 * skipped rather than spending a pass to copy the plate.
 *
 * Note gain and headroom are NOT part of this: compress(expand(c)) is the
 * identity, so at gain 1 they cannot change a pixel either, and at gain != 1 the
 * effect is a legitimate exposure change that must still run.
 */
export function timeshiftIsBypass(params) {
  const shift = Math.abs(Number.isFinite(params?.shift) ? params.shift : 0);
  const shutter = Math.max(0, (params?.shutter ?? 180) / 360);
  const gain = Math.max(0, (params?.gain ?? 100) / 100);
  return shift < 1e-4 && shutter < 1e-4 && Math.abs(gain - 1) < 1e-4;
}
