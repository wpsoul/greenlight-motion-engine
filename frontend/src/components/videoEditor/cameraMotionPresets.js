// Camera Motion presets — the catalog behind CameraMotionModal.
//
// Same "common snapshot" shape as CAMERA_PRESETS (projectCamera.js): positions are
// 0–100% of the camera clip, easing lives on the LOW key (gsapTransitions reads
// `low.easing` for the segment that follows), and every key carries a FULL property
// snapshot. That last part is load-bearing: keys are consumed per-property by
// commonToPropertyKeyframes, so a key that omits a prop would simply not exist on
// that prop's track — authoring compactly and expanding at module load keeps the
// source readable without re-introducing the "end key of {} means no motion" trap
// the look-dev hit (html/camera-motion-presets-modal.html).
//
// Three presets use the legacy MotionFast sampled curves (Impulse / Swing /
// Overshoot from easingCurves.js) — a single segment of those carries anticipation
// and follow-through, which is what makes Slingshot rear back before launching.
//
// Look-dev: html/camera-motion-presets-modal.html. Rounds of user taste baked in
// there: Quiet Push / Fast Orbit / Step Zoom / Handheld Breath / Figure Eight are
// approved; preview scene must stay ONE white rounded object on a flat ground.

import { TransitionEasing } from './types';

// Neutral pose — also what the preview evaluator falls back to for missing props.
export const CAMERA_MOTION_NEUTRAL = {
  camZoom: 1, camX: 0, camY: 0, camRoll: 0, camDolly: 0, camTiltX: 0, camTiltY: 0,
};

// DOF fields only enter a preset's snapshots when the preset actually uses them:
// a motion move must NOT carry constant DOF tracks, or applying it would stomp the
// camera's static depth-of-field setup (the old popover presets kept the two
// families separate for the same reason).
const DOF_DEFAULTS = {
  camDofEnabled: 0, camFocusDistance: 0, camFocusX: 50, camFocusY: 50,
  camAperture: 24, camBlurLevel: 100, camHighlightGain: 0, camFocusWidth: 0,
};

const E = TransitionEasing;

// Compact authoring: `v` holds only the props that CHANGE at that key; expansion
// below fills the rest from the previous key so every stored key is a full snapshot.
// `e` is the easing of the segment that FOLLOWS the key; `b` is that segment's
// bezier, read only when `e` is CUSTOM (the graph editor's own key shape).
const RAW = [
  // ── Cinematic ──
  { id: 'cm-quiet-push', category: 'Cinematic', name: 'Quiet Push', easeLabel: 'AE Smooth', duration: 6,
    description: 'A restrained forward creep — attention without announcing itself',
    k: [ { p: 0, e: E.AE_SMOOTH, v: { camZoom: 1.02, camY: 1 } },
         { p: 100, v: { camZoom: 1.16, camDolly: 80, camY: 0 } } ] },

  { id: 'cm-swoop-dive', category: 'Cinematic', name: 'Swoop Dive', easeLabel: 'Expo Out', duration: 4.5,
    description: 'A drone dive from high and behind that levels off at the subject',
    k: [ { p: 0, e: E.EXPO_OUT, v: { camY: 9, camTiltX: -14, camZoom: 1.35, camDolly: -120, camRoll: -3 } },
         { p: 100, v: { camY: -3, camTiltX: 3, camZoom: 1.1, camDolly: 160, camRoll: 0 } } ] },

  { id: 'cm-corkscrew', category: 'Cinematic', name: 'Corkscrew', easeLabel: 'AE Smooth', duration: 5,
    description: 'Screws in from a canted wide — roll, yaw and zoom resolve together',
    k: [ { p: 0, e: E.AE_SMOOTH, v: { camRoll: -22, camTiltY: -10, camZoom: 1.6, camX: -5, camY: -3 } },
         { p: 100, v: { camRoll: 0, camTiltY: 4, camZoom: 1.08, camX: 1, camY: 0 } } ] },

  { id: 'cm-fast-orbit', category: 'Cinematic', name: 'Fast Orbit', easeLabel: 'Linear', duration: 3,
    description: 'A brisk constant-speed yaw sweep with real angular strength',
    k: [ { p: 0, e: E.LINEAR, v: { camTiltY: -20, camX: -8, camZoom: 1.12 } },
         { p: 100, v: { camTiltY: 20, camX: 8, camZoom: 1.12 } } ] },

  // Ported from the retired popover catalog (CAMERA_PRESETS 'lateral-glide').
  { id: 'cm-lateral-glide', category: 'Cinematic', name: 'Lateral Glide', easeLabel: 'Smooth', duration: 6,
    description: 'A polished slider move with just enough yaw to reveal depth',
    k: [ { p: 0, e: E.EASE_IN_OUT, v: { camX: -7, camY: 0.8, camTiltY: -1.8, camZoom: 1.08 } },
         { p: 50, e: E.EASE_IN_OUT, v: { camX: 0, camY: 0, camTiltY: 0, camZoom: 1.1 } },
         { p: 100, v: { camX: 7, camY: -0.8, camTiltY: 1.8, camZoom: 1.12 } } ] },

  // Ported from the retired popover catalog (CAMERA_PRESETS 'parallax-arc').
  { id: 'cm-parallax-arc', category: 'Cinematic', name: 'Parallax Arc', easeLabel: 'Smooth', duration: 7,
    description: 'An arcing move that lets foreground and background separate',
    k: [ { p: 0, e: E.EASE_IN_OUT, v: { camX: -8, camTiltY: -4.5, camDolly: -80, camZoom: 1.08 } },
         { p: 50, e: E.EASE_IN_OUT, v: { camX: 0, camTiltY: 0, camDolly: 170, camZoom: 1.13 } },
         { p: 100, v: { camX: 8, camTiltY: 4.5, camDolly: -80, camZoom: 1.08 } } ] },

  // Ported from the Mockup builder's Arc Close-Up (mockupGenerator/PresetsPanel.jsx).
  { id: 'cm-arc-closeup', category: 'Cinematic', name: 'Arc Close-Up', easeLabel: 'Cubic Out', duration: 6,
    description: 'Sweeps in on an arc and lands in a crisp close detail',
    k: [ { p: 0, e: E.CUBIC_OUT, v: { camX: -11, camY: 2, camTiltY: -9, camDolly: -140, camZoom: 0.96 } },
         { p: 30, e: E.EASE_IN_OUT, v: { camX: -4, camY: 1, camTiltY: -4, camDolly: 40, camZoom: 1.06 } },
         { p: 65, e: E.EASE_IN_OUT, v: { camX: 5, camY: -1, camTiltY: 2, camDolly: 230, camZoom: 1.26 } },
         { p: 100, v: { camX: 1.5, camY: 0, camTiltY: 3, camDolly: 160, camZoom: 1.16 } } ] },

  // ── Editorial ──
  { id: 'cm-slingshot', category: 'Editorial', name: 'Slingshot', easeLabel: 'Impulse', duration: 1.8,
    description: 'Pulls back to load, then launches forward — one Impulse segment',
    k: [ { p: 0, e: E.IMPULSE, v: { camZoom: 1.05 } },
         { p: 100, v: { camZoom: 1.75, camDolly: 260, camY: -1 } } ] },

  { id: 'cm-step-zoom', category: 'Editorial', name: 'Step Zoom', easeLabel: 'Hold (cuts)', duration: 2.4,
    description: 'Three hard cuts closer — hold keys, no interpolation at all',
    k: [ { p: 0, e: E.HOLD, v: {} },
         { p: 25, e: E.HOLD, v: { camZoom: 1.16, camX: 2 } },
         { p: 50, e: E.HOLD, v: { camZoom: 1.32, camX: -1.5 } },
         { p: 75, e: E.HOLD, v: { camZoom: 1.5, camX: 0 } },
         { p: 100, v: {} } ] },

  { id: 'cm-handheld-breath', category: 'Editorial', name: 'Handheld Breath', easeLabel: 'Sine', duration: 8,
    description: 'Small, irregular operator drift without the synthetic wobble',
    k: [ { p: 0, e: E.SINE_IN_OUT, v: { camX: -0.4, camY: 0.4, camRoll: -0.15, camZoom: 1.05 } },
         { p: 19, e: E.SINE_IN_OUT, v: { camX: 1.1, camY: -0.6, camRoll: 0.3, camZoom: 1.062 } },
         { p: 43, e: E.SINE_IN_OUT, v: { camX: -0.8, camY: 0.9, camRoll: -0.25, camZoom: 1.054 } },
         { p: 68, e: E.SINE_IN_OUT, v: { camX: 0.6, camY: 0.2, camRoll: 0.2, camZoom: 1.068 } },
         { p: 87, e: E.SINE_IN_OUT, v: { camX: -0.9, camY: -0.5, camRoll: -0.22, camZoom: 1.058 } },
         { p: 100, v: { camX: -0.4, camY: 0.4, camRoll: -0.15, camZoom: 1.05 } } ] },

  // Ported from the Mockup builder's Soft Land.
  { id: 'cm-soft-land', category: 'Editorial', name: 'Soft Land', easeLabel: 'Expo Out', duration: 4.2,
    description: 'Drops in from above and settles onto the framing without a bump',
    k: [ { p: 0, e: E.EXPO_OUT, v: { camY: 9, camTiltX: -8, camDolly: -130, camZoom: 0.94, camRoll: -2 } },
         { p: 60, e: E.EASE_IN_OUT, v: { camY: -0.6, camTiltX: 1.2, camDolly: 30, camZoom: 1.04, camRoll: 0.4 } },
         { p: 100, v: { camY: 0, camTiltX: 0.6, camDolly: 0, camZoom: 1.01, camRoll: 0 } } ] },

  // Ported from the retired popover catalog (CAMERA_PRESETS 'documentary-follow').
  { id: 'cm-documentary-follow', category: 'Editorial', name: 'Documentary Follow', easeLabel: 'Smooth', duration: 5,
    description: 'A gently imperfect follow move that keeps finding the subject',
    k: [ { p: 0, e: E.EASE_IN_OUT, v: { camX: -3, camY: 1.5, camRoll: -0.15, camZoom: 1.06 } },
         { p: 38, e: E.EASE_IN_OUT, v: { camX: 1, camY: -0.5, camRoll: 0.25, camZoom: 1.1 } },
         { p: 72, e: E.EASE_IN_OUT, v: { camX: -0.5, camY: 0.8, camRoll: -0.1, camZoom: 1.08 } },
         { p: 100, v: { camX: 2.5, camY: 0, camRoll: 0.1, camZoom: 1.12 } } ] },

  // ── Energy ──
  { id: 'cm-weave-run', category: 'Energy', name: 'Weave Run', easeLabel: 'Sine', duration: 5.5,
    description: 'A forward run that slaloms through the frame, banking into each turn',
    k: [ { p: 0, e: E.SINE_IN_OUT, v: { camX: -8, camRoll: -3, camDolly: -150, camZoom: 1.1, camTiltY: -4 } },
         { p: 30, e: E.SINE_IN_OUT, v: { camX: 6, camRoll: 3, camDolly: 0, camTiltY: 3 } },
         { p: 60, e: E.SINE_IN_OUT, v: { camX: -5, camRoll: -2.5, camDolly: 140, camTiltY: -3 } },
         { p: 100, v: { camX: 7, camRoll: 2, camDolly: 300, camTiltY: 4 } } ] },

  // Ported from the Mockup builder's S-Curve Drift.
  { id: 'cm-s-curve-drift', category: 'Energy', name: 'S-Curve Drift', easeLabel: 'Smooth', duration: 6.5,
    description: 'An elegant S-shaped path that keeps changing direction mid-drift',
    k: [ { p: 0, e: E.EASE_IN_OUT, v: { camX: -10, camY: 3, camTiltY: -6, camDolly: -90, camZoom: 1.05, camRoll: -1 } },
         { p: 33, e: E.EASE_IN_OUT, v: { camX: 4, camY: -1.5, camTiltY: 1, camDolly: 60, camZoom: 1.12, camRoll: 0.5 } },
         { p: 66, e: E.EASE_IN_OUT, v: { camX: -3, camY: 1, camTiltY: -2, camDolly: 160, camZoom: 1.18, camRoll: -0.5 } },
         { p: 100, v: { camX: 10, camY: -2, camTiltY: 5, camDolly: 90, camZoom: 1.1, camRoll: 1 } } ] },

  // Ported from the Mockup builder's Macro Sweep.
  { id: 'cm-macro-sweep', category: 'Energy', name: 'Macro Sweep', easeLabel: 'Smooth', duration: 5,
    description: 'Stays tight on the subject while sweeping across it side to side',
    k: [ { p: 0, e: E.EASE_IN_OUT, v: { camZoom: 1.5, camX: -8, camTiltY: -5, camY: 1 } },
         { p: 50, e: E.EASE_IN_OUT, v: { camZoom: 1.62, camX: 2, camTiltY: 1, camY: -0.5 } },
         { p: 100, v: { camZoom: 1.46, camX: 9, camTiltY: 5, camY: 1 } } ] },

  // Authored by hand in the graph editor (the "8.8 Preview" project) and lifted from
  // it verbatim. Pure DOLLY, no zoom: the viewpoint really travels, so the parallax
  // opens up instead of the lens just magnifying. Two very different segments —
  // 0–71 % is a LINEAR creep of ~137 px that reads as almost nothing, then one
  // hand-shaped segment holds and detonates (dolly ~490 at its midpoint, ~1420 at
  // 90 %, 2600 at the end). 2600 is past the comp plane of a 1080-tall project
  // (perspectiveDistance ≈ 2166), so the last instant flies THROUGH the frame —
  // that blow-out is the point of the move, not a bug. Park layers on negative panZ
  // if you want the camera to stop short of them instead. `sparse` keeps it to the
  // ONE dolly track — no constant zoom/pan/roll/tilt tracks to wade through in the
  // keyframe builder, and it layers onto a pose you have already framed.
  { id: 'cm-punch-through', category: 'Energy', name: 'Punch Through', easeLabel: 'Custom', duration: 8.7, sparse: true,
    description: 'A long, almost invisible creep forward that detonates into a flight straight through the frame',
    k: [ { p: 0, e: E.LINEAR, v: { camDolly: 98 } },
         { p: 71, e: E.CUSTOM, b: [0.8187, 0.1079, 0.9089, 0.302], v: { camDolly: 234.7692 } },
         { p: 100, e: E.AE_IN, v: { camDolly: 2600 } } ] },

  // ── Loops (first and last snapshots match, so trimming loops cleanly) ──
  { id: 'cm-orbit-pulse', category: 'Loops', name: 'Orbit Pulse', easeLabel: 'Sine', duration: 7,
    description: 'A seamless orbit that breathes closer on every pass',
    k: [ { p: 0, e: E.SINE_IN_OUT, v: { camTiltY: -13, camX: -5, camY: 1, camZoom: 1.06 } },
         { p: 50, e: E.SINE_IN_OUT, v: { camTiltY: 13, camX: 5, camY: -1, camZoom: 1.2 } },
         { p: 100, v: { camTiltY: -13, camX: -5, camY: 1, camZoom: 1.06 } } ] },

  // Ported from the Mockup builder's Float & Rotate.
  { id: 'cm-float', category: 'Loops', name: 'Float', easeLabel: 'Sine', duration: 5.5,
    description: 'A weightless vertical bob with a slow roll — ambient and seamless',
    k: [ { p: 0, e: E.SINE_IN_OUT, v: { camY: 2.2, camRoll: -1.6, camZoom: 1.1 } },
         { p: 50, e: E.SINE_IN_OUT, v: { camY: -2.2, camRoll: 1.6, camZoom: 1.17 } },
         { p: 100, v: { camY: 2.2, camRoll: -1.6, camZoom: 1.1 } } ] },

  { id: 'cm-figure-eight', category: 'Loops', name: 'Figure Eight', easeLabel: 'Sine', duration: 6,
    description: 'Traces a loop through the frame and returns exactly to its start',
    k: [ { p: 0, e: E.SINE_IN_OUT, v: { camX: -11, camY: 0, camRoll: 0, camZoom: 1.15 } },
         { p: 25, e: E.SINE_IN_OUT, v: { camX: 0, camY: 7, camRoll: 2.5 } },
         { p: 50, e: E.SINE_IN_OUT, v: { camX: 11, camY: 0, camRoll: 0 } },
         { p: 75, e: E.SINE_IN_OUT, v: { camX: 0, camY: -7, camRoll: -2.5 } },
         { p: 100, v: { camX: -11, camY: 0, camRoll: 0 } } ] },

  // ── Focus (ported from the retired popover catalog; DOF tracks, so they only
  //    read with the camera's Depth of Field enabled — they enable it themselves) ──
  { id: 'cm-rack-to-near', category: 'Focus', name: 'Rack to Near', easeLabel: 'Smooth', duration: 3.5,
    description: 'Holds the background, then pulls focus onto a near subject',
    k: [ { p: 0, e: E.EASE_IN_OUT, v: { camDofEnabled: 1, camFocusDistance: 2800, camFocusX: 68, camFocusY: 48, camAperture: 36, camBlurLevel: 110, camHighlightGain: 18 } },
         { p: 22, e: E.EASE_IN_OUT, v: {} },
         { p: 78, e: E.EASE_IN_OUT, v: { camFocusDistance: 1350, camFocusX: 35, camFocusY: 55 } },
         { p: 100, v: {} } ] },

  { id: 'cm-rack-to-far', category: 'Focus', name: 'Rack to Far', easeLabel: 'Smooth', duration: 3.5,
    description: 'Transfers attention from a close detail to the scene behind it',
    k: [ { p: 0, e: E.EASE_IN_OUT, v: { camDofEnabled: 1, camFocusDistance: 1350, camFocusX: 35, camFocusY: 55, camAperture: 36, camBlurLevel: 110, camHighlightGain: 18 } },
         { p: 22, e: E.EASE_IN_OUT, v: {} },
         { p: 78, e: E.EASE_IN_OUT, v: { camFocusDistance: 2800, camFocusX: 68, camFocusY: 48 } },
         { p: 100, v: {} } ] },

  { id: 'cm-focus-chase', category: 'Focus', name: 'Focus Chase', easeLabel: 'Smooth', duration: 6,
    description: 'Moves attention across three depth beats for layered layouts',
    k: [ { p: 0, e: E.EASE_IN_OUT, v: { camDofEnabled: 1, camFocusDistance: 1450, camFocusX: 28, camFocusY: 55, camAperture: 30, camBlurLevel: 95, camHighlightGain: 12 } },
         { p: 45, e: E.EASE_IN_OUT, v: { camFocusDistance: 2600, camFocusX: 72, camFocusY: 42 } },
         { p: 100, v: { camFocusDistance: 1750, camFocusX: 48, camFocusY: 50 } } ] },

  { id: 'cm-macro-bloom', category: 'Focus', name: 'Macro Bloom', easeLabel: 'Smooth', duration: 4.5,
    description: 'Pushes into a detail while focus and highlight bloom tighten',
    k: [ { p: 0, e: E.EASE_IN_OUT, v: { camZoom: 1.05, camDolly: 0, camDofEnabled: 1, camFocusDistance: 2500, camFocusX: 50, camFocusY: 50, camAperture: 28, camBlurLevel: 100, camHighlightGain: 15 } },
         { p: 52, e: E.EASE_IN_OUT, v: { camZoom: 1.16, camDolly: 100, camFocusDistance: 1650, camAperture: 46, camBlurLevel: 125, camHighlightGain: 32 } },
         { p: 100, v: { camZoom: 1.23, camDolly: 180, camFocusDistance: 1150, camAperture: 38, camBlurLevel: 110, camHighlightGain: 22 } } ] },

  // Deliberately LAST in the wall (user's call) rather than up with the other
  // Cinematic moves — array order is card order, in "All" and inside a category chip
  // alike. The reveal itself is an ENDING beat: hold the close-up, swing open in the
  // last stretch.
  { id: 'cm-grand-reveal', category: 'Cinematic', name: 'Grand Reveal', easeLabel: 'Smooth', duration: 3.5,
    description: 'Holds an extreme tilted close-up, then swings open right at the end',
    k: [ { p: 0, e: E.LINEAR, v: { camZoom: 2.3, camRoll: -5, camY: -4, camDolly: 220 } },
         { p: 55, e: E.EASE_IN_OUT, v: {} },
         { p: 100, v: { camZoom: 1, camRoll: 0, camY: 0, camDolly: 0 } } ] },
];

export const CAMERA_MOTION_CATEGORIES = ['Cinematic', 'Editorial', 'Energy', 'Loops', 'Focus'];

// Expand compact keys into the stored shape: every key a full snapshot with string
// values (the editor's keyframe value type), easing defaulted like the app does.
// A preset that moves the camera seeds ALL motion props (applying it resets pose,
// like the retired popover presets did); DOF props are seeded only when the preset
// actually animates depth of field.
//
// `sparse` opts a preset out of that reset: it lays down tracks ONLY for the props it
// actually animates, so it composes with whatever pose the camera already holds
// instead of flattening it. Use it for single-axis moves (Punch Through is pure
// dolly) where six constant tracks would be noise in the keyframe builder.
export const CAMERA_MOTION_PRESETS = RAW.map(({ k, sparse, ...meta }) => {
  const used = new Set(k.flatMap((key) => Object.keys(key.v)));
  const usesMotion = !sparse && Object.keys(CAMERA_MOTION_NEUTRAL).some((prop) => used.has(prop));
  let prev = usesMotion ? { ...CAMERA_MOTION_NEUTRAL } : {};
  for (const prop of Object.keys(DOF_DEFAULTS)) {
    if (used.has(prop)) prev[prop] = DOF_DEFAULTS[prop];
  }
  const keyframes = k.map((key) => {
    const pose = { ...prev, ...key.v };
    prev = pose;
    const properties = {};
    for (const [prop, value] of Object.entries(pose)) properties[prop] = String(value);
    return {
      position: key.p,
      easing: key.e || TransitionEasing.EASE_IN_OUT,
      ...(key.b ? { bezier: [...key.b] } : {}),
      properties,
    };
  });
  return { ...meta, keyframes };
});

/** Numeric pose at `t` (0..1) for the modal's live previews. Mirrors the editor's
 *  rule: easing on the low key shapes the following segment; HOLD steps. The
 *  easing→function resolution is injected so this module stays a data leaf — it is
 *  passed the low key's own `bezier` too, which is what a CUSTOM segment rides. */
export function evalMotionPose(preset, t, easeFnFor) {
  const keys = preset.keyframes;
  const pos = Math.max(0, Math.min(100, t * 100));
  const num = (key) => {
    const out = {};
    for (const [prop, raw] of Object.entries(key.properties)) out[prop] = Number.parseFloat(raw);
    return out;
  };
  if (pos <= keys[0].position) return num(keys[0]);
  if (pos >= keys[keys.length - 1].position) return num(keys[keys.length - 1]);
  let i = 0;
  while (i < keys.length - 2 && keys[i + 1].position <= pos) i++;
  const a = keys[i];
  const b = keys[i + 1];
  if (a.easing === TransitionEasing.HOLD) return num(a);
  const fn = easeFnFor(a.easing, a.bezier);
  const f = fn((pos - a.position) / (b.position - a.position));
  const va = num(a);
  const vb = num(b);
  const out = {};
  for (const prop of Object.keys(va)) out[prop] = va[prop] + (vb[prop] - va[prop]) * f;
  return out;
}
