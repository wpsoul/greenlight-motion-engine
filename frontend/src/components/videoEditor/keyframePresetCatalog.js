/*
 * The Video Editor's keyframe animation presets (Keyframes ▸ Presets), shared by the editor panel (EditorPanel.jsx)
 * and the GreenLight Motion page (motionEngine/PlayerPage.jsx) — moved here verbatim from EditorPanel.jsx.
 *
 * applyKeyframePreset() is the editor's apply (EditorPanel applyPreset) as a pure function: a preset (resolved to its
 * direction / In or Out by resolvePresetVariant) written into a layer's tracks over a range of it.
 */
import { TransitionEasing } from './types';
import { commonToPropertyKeyframes, mirrorCommonKeyframes, scalePropertyKeyframesToRange, mergePropertyKeyframesInRange } from './gsapTransitions';
import { sanitizeKeyframeFxMap } from './keyframeFx';
import { directedKeyframes, directionsOf, oppositeDirection } from './presetDirections';

// Easing convention: the simple move / scale / colour presets below use
// TransitionEasing.AE_SMOOTH — the After Effects easy-ease bezier — rather than
// gsap's Ease In / Ease Out / Smooth, which read mechanical next to AE-authored
// motion. LINEAR stays where a segment is a deliberate hold or a constant-velocity
// drift, and SINE_IN_OUT stays on the orbit/drift loops it was tuned for. The
// "click / spring / wobble" family further down keeps its elastic/bounce/back/power
// curves — those curves ARE the preset.
export const KEYFRAME_PRESETS = [
  {
    id: 'slide',
    cat: 'slide',
    directions: 'cardinal',
    baseDir: 'left',
    outName: 'Slide Out',
    name: 'Slide',
    description: 'Slides in from the edge',
    outDescription: 'Slides out over the edge',
    keyframes: [
      { position: 0, easing: TransitionEasing.AE_SMOOTH, properties: { xPercent: '100' } },
      { position: 35, easing: TransitionEasing.AE_SMOOTH, properties: { xPercent: '0' } },
      { position: 100, easing: TransitionEasing.LINEAR, properties: { xPercent: '0' } },
    ],
  },
  // In and Out: one move over the whole range — it enters, glides across and leaves — on the owner's Smooth Glide
  // curve plus the Glide ƒx it was tuned with on the "Easing study" board (Soft: 0.1 s response, 0.6 s tail, 25 %).
  // The ƒx lags (its tail is in seconds), so the keys are placed for it — measured with the app's own glideValue over
  // 1.5–4 s layers: in from 100 % (off-frame), out to −150 % with the last key at 80 %, so the tail has caught up and
  // the layer has left (−130…−145 %) by the end and the slow middle lands near the centre.
  // Each is authored travelling one way (`baseDir`); the modal's Direction pad turns it (presetDirections.js), so one
  // preset covers every direction. `inOut` keeps the Outro from playing it backwards: it is an entrance AND an exit.
  // The 15 after Glide are the owner's picks from html/glide-inout-lab.html (2026-10-16).
  {
    id: 'glide',
    cat: 'inout',
    inOut: true,
    directions: 'cardinal',
    baseDir: 'left',
    name: 'Glide',
    description: 'Comes in, glides across and leaves on the other side',
    keyframes: [
      { position: 0, easing: TransitionEasing.SMOOTH_GLIDE, properties: { xPercent: '100' } },
      { position: 80, easing: TransitionEasing.LINEAR, properties: { xPercent: '-150' } },
    ],
    fx: { xPercent: { type: 'glide', params: { fast: 0.1, slow: 0.6, weight: 25, delay: 0 } } },
  },
  {
    id: 'glide-stop',
    cat: 'inout',
    inOut: true,
    directions: 'cardinal',
    baseDir: 'left',
    name: 'Glide Stop',
    description: 'Jumps in, all but stops in the middle, then jumps out — the Glide Easing Stop curve',
    keyframes: [
      { position: 0, easing: TransitionEasing.GLIDE_STOP, properties: { xPercent: '100' } },
      { position: 80, easing: TransitionEasing.LINEAR, properties: { xPercent: '-150' } },
    ],
    fx: { xPercent: { type: 'glide', params: { fast: 0.1, slow: 0.6, weight: 25, delay: 0 } } },
  },
  {
    id: 'glide-floaty',
    cat: 'inout',
    inOut: true,
    directions: 'cardinal',
    baseDir: 'left',
    name: 'Glide Floaty',
    description: 'The same pass with a heavier tail: it keeps drifting after each push',
    keyframes: [
      { position: 0, easing: TransitionEasing.SMOOTH_GLIDE, properties: { xPercent: '100' } },
      { position: 80, easing: TransitionEasing.LINEAR, properties: { xPercent: '-150' } },
    ],
    fx: { xPercent: { type: 'glide', params: { fast: 0.1, slow: 1, weight: 40, delay: 0 } } },
  },
  {
    id: 'glide-endless',
    cat: 'inout',
    inOut: true,
    directions: 'cardinal',
    baseDir: 'left',
    name: 'Glide Endless',
    description: 'A long, light tail — it never quite stops before it leaves',
    keyframes: [
      { position: 0, easing: TransitionEasing.SMOOTH_GLIDE, properties: { xPercent: '100' } },
      { position: 80, easing: TransitionEasing.LINEAR, properties: { xPercent: '-150' } },
    ],
    fx: { xPercent: { type: 'glide', params: { fast: 0.1, slow: 2, weight: 14, delay: 0 } } },
  },
  {
    id: 'glide-diagonal',
    cat: 'inout',
    inOut: true,
    directions: 'diagonal',
    baseDir: 'upLeft',
    name: 'Glide Diagonal',
    description: 'Crosses corner to corner in one glide',
    keyframes: [
      { position: 0, easing: TransitionEasing.SMOOTH_GLIDE, properties: { xPercent: '100', yPercent: '60' } },
      { position: 80, easing: TransitionEasing.LINEAR, properties: { xPercent: '-150', yPercent: '-90' } },
    ],
    fx: { xPercent: { type: 'glide', params: { fast: 0.1, slow: 0.6, weight: 25, delay: 0 } }, yPercent: { type: 'glide', params: { fast: 0.1, slow: 0.6, weight: 25, delay: 0 } } },
  },
  {
    id: 'glide-arc',
    cat: 'inout',
    inOut: true,
    directions: 'cardinal',
    baseDir: 'left',
    name: 'Glide Arc',
    description: 'Crosses on a gentle arch over the middle',
    keyframes: [
      { position: 0, easing: TransitionEasing.SMOOTH_GLIDE, properties: { xPercent: '100' } },
      { position: 80, easing: TransitionEasing.LINEAR, properties: { xPercent: '-150' } },
      { position: 0, easing: TransitionEasing.EASE_OUT, properties: { yPercent: '0' } },
      { position: 40, easing: TransitionEasing.EASE_IN, properties: { yPercent: '-16' } },
      { position: 80, easing: TransitionEasing.LINEAR, properties: { yPercent: '0' } },
    ],
    fx: { xPercent: { type: 'glide', params: { fast: 0.1, slow: 0.6, weight: 25, delay: 0 } } },
  },
  {
    id: 'glide-close-pass',
    cat: 'inout',
    inOut: true,
    directions: 'cardinal',
    baseDir: 'left',
    name: 'Glide Close Pass',
    description: 'Swells slightly as it passes, as if it came closer',
    keyframes: [
      { position: 0, easing: TransitionEasing.SMOOTH_GLIDE, properties: { xPercent: '100' } },
      { position: 80, easing: TransitionEasing.LINEAR, properties: { xPercent: '-150' } },
      { position: 0, easing: TransitionEasing.EASE_IN_OUT, properties: { scale: '0.82' } },
      { position: 40, easing: TransitionEasing.EASE_IN_OUT, properties: { scale: '1.08' } },
      { position: 80, easing: TransitionEasing.LINEAR, properties: { scale: '0.82' } },
    ],
    fx: { xPercent: { type: 'glide', params: { fast: 0.1, slow: 0.6, weight: 25, delay: 0 } } },
  },
  {
    id: 'glide-fade-drift',
    cat: 'inout',
    inOut: true,
    directions: 'cardinal',
    baseDir: 'left',
    name: 'Glide Fade Drift',
    description: 'A shorter drift that fades in and out instead of leaving the frame',
    keyframes: [
      { position: 0, easing: TransitionEasing.SMOOTH_GLIDE, properties: { xPercent: '45' } },
      { position: 100, easing: TransitionEasing.LINEAR, properties: { xPercent: '-45' } },
      { position: 0, easing: TransitionEasing.EASE_OUT, properties: { opacity: '0' } },
      { position: 22, easing: TransitionEasing.LINEAR, properties: { opacity: '1' } },
      { position: 78, easing: TransitionEasing.EASE_IN, properties: { opacity: '1' } },
      { position: 100, easing: TransitionEasing.LINEAR, properties: { opacity: '0' } },
    ],
    fx: { xPercent: { type: 'glide', params: { fast: 0.1, slow: 0.6, weight: 25, delay: 0 } } },
  },
  {
    id: 'glide-bank',
    cat: 'inout',
    inOut: true,
    directions: 'cardinal',
    baseDir: 'left',
    name: 'Glide Bank',
    description: 'Leans into the move like a car taking a long bend',
    keyframes: [
      { position: 0, easing: TransitionEasing.SMOOTH_GLIDE, properties: { xPercent: '100' } },
      { position: 80, easing: TransitionEasing.LINEAR, properties: { xPercent: '-150' } },
      { position: 0, easing: TransitionEasing.SMOOTH_GLIDE, properties: { rotate: '9' } },
      { position: 80, easing: TransitionEasing.LINEAR, properties: { rotate: '-9' } },
    ],
    fx: { xPercent: { type: 'glide', params: { fast: 0.1, slow: 0.6, weight: 25, delay: 0 } } },
  },
  {
    id: 'glide-swing-3d',
    cat: 'inout',
    inOut: true,
    directions: 'cardinal',
    baseDir: 'left',
    name: 'Glide Swing 3D',
    description: 'Turns to face you as it passes, then turns away',
    keyframes: [
      { position: 0, easing: TransitionEasing.SMOOTH_GLIDE, properties: { xPercent: '100' } },
      { position: 80, easing: TransitionEasing.LINEAR, properties: { xPercent: '-150' } },
      { position: 0, easing: TransitionEasing.SMOOTH_GLIDE, properties: { rotateY: '42' } },
      { position: 80, easing: TransitionEasing.LINEAR, properties: { rotateY: '-42' } },
    ],
    fx: { xPercent: { type: 'glide', params: { fast: 0.1, slow: 0.6, weight: 25, delay: 0 } } },
  },
  {
    id: 'glide-linger',
    cat: 'inout',
    inOut: true,
    directions: 'cardinal',
    baseDir: 'left',
    name: 'Glide Linger',
    description: 'Snaps in, lingers almost still for most of the layer, snaps out',
    keyframes: [
      { position: 0, easing: TransitionEasing.CUSTOM, bezier: [0.05, 0.85, 0.95, 0.15], properties: { xPercent: '100' } },
      { position: 80, easing: TransitionEasing.LINEAR, properties: { xPercent: '-150' } },
    ],
    fx: { xPercent: { type: 'glide', params: { fast: 0.1, slow: 0.6, weight: 25, delay: 0 } } },
  },
  {
    id: 'glide-soft-entry',
    cat: 'inout',
    inOut: true,
    directions: 'cardinal',
    baseDir: 'left',
    name: 'Glide Soft Entry',
    description: 'A slower, softer arrival, a long glide, then a quick exit',
    keyframes: [
      { position: 0, easing: TransitionEasing.CUSTOM, bezier: [0.45, 0.7, 0.85, 0.05], properties: { xPercent: '100' } },
      { position: 80, easing: TransitionEasing.LINEAR, properties: { xPercent: '-150' } },
    ],
    fx: { xPercent: { type: 'glide', params: { fast: 0.1, slow: 0.6, weight: 25, delay: 0 } } },
  },
  {
    id: 'glide-blur',
    cat: 'inout',
    inOut: true,
    directions: 'cardinal',
    baseDir: 'up',
    name: 'Glide Blur',
    description: 'Comes in through a blur, sharp while it glides, blurs again as it leaves',
    keyframes: [
      { position: 0, easing: TransitionEasing.SMOOTH_GLIDE, properties: { yPercent: '100' } },
      { position: 80, easing: TransitionEasing.LINEAR, properties: { yPercent: '-150' } },
      { position: 0, easing: TransitionEasing.EASE_OUT, properties: { blur: '14' } },
      { position: 28, easing: TransitionEasing.LINEAR, properties: { blur: '0' } },
      { position: 52, easing: TransitionEasing.EASE_IN, properties: { blur: '0' } },
      { position: 80, easing: TransitionEasing.LINEAR, properties: { blur: '14' } },
    ],
    fx: { yPercent: { type: 'glide', params: { fast: 0.1, slow: 0.6, weight: 25, delay: 0 } } },
  },
  {
    id: 'glide-spin-through',
    cat: 'inout',
    inOut: true,
    directions: 'cardinal',
    baseDir: 'left',
    name: 'Glide Spin Through',
    description: 'Spins in, glides level, spins out',
    keyframes: [
      { position: 0, easing: TransitionEasing.SMOOTH_GLIDE, properties: { xPercent: '100' } },
      { position: 80, easing: TransitionEasing.LINEAR, properties: { xPercent: '-150' } },
      { position: 0, easing: TransitionEasing.SMOOTH_GLIDE, properties: { rotate: '120' } },
      { position: 80, easing: TransitionEasing.LINEAR, properties: { rotate: '-120' } },
    ],
    fx: { xPercent: { type: 'glide', params: { fast: 0.1, slow: 0.6, weight: 25, delay: 0 } } },
  },
  {
    id: 'glide-depth-pass',
    cat: 'inout',
    inOut: true,
    directions: 'cardinal',
    baseDir: 'left',
    name: 'Glide Depth Pass',
    description: 'Comes from close and blurred, passes, recedes into the distance',
    keyframes: [
      { position: 0, easing: TransitionEasing.SMOOTH_GLIDE, properties: { xPercent: '100' } },
      { position: 80, easing: TransitionEasing.LINEAR, properties: { xPercent: '-150' } },
      { position: 0, easing: TransitionEasing.SMOOTH_GLIDE, properties: { scale: '1.35' } },
      { position: 80, easing: TransitionEasing.LINEAR, properties: { scale: '0.7' } },
      { position: 0, easing: TransitionEasing.EASE_OUT, properties: { blur: '10' } },
      { position: 32, easing: TransitionEasing.LINEAR, properties: { blur: '0' } },
      { position: 60, easing: TransitionEasing.EASE_IN, properties: { blur: '0' } },
      { position: 80, easing: TransitionEasing.LINEAR, properties: { blur: '6' } },
    ],
    fx: { xPercent: { type: 'glide', params: { fast: 0.1, slow: 0.6, weight: 25, delay: 0 } } },
  },
  {
    id: 'glide-tilt',
    cat: 'inout',
    inOut: true,
    directions: 'cardinal',
    baseDir: 'down',
    name: 'Glide Tilt',
    description: 'Drops in, all but stops tilted, falls away',
    keyframes: [
      { position: 0, easing: TransitionEasing.GLIDE_STOP, properties: { yPercent: '-100' } },
      { position: 80, easing: TransitionEasing.LINEAR, properties: { yPercent: '150' } },
      { position: 0, easing: TransitionEasing.GLIDE_STOP, properties: { rotate: '-10' } },
      { position: 80, easing: TransitionEasing.LINEAR, properties: { rotate: '10' } },
    ],
    fx: { yPercent: { type: 'glide', params: { fast: 0.1, slow: 0.6, weight: 25, delay: 0 } } },
  },
  {
    id: 'zoom-in',
    cat: 'scale',
    outName: 'Zoom Out',
    name: 'Zoom In',
    description: 'Continuous push-in over the clip',
    keyframes: [
      { position: 0, easing: TransitionEasing.AE_SMOOTH, properties: { scale: '1' } },
      { position: 100, easing: TransitionEasing.AE_SMOOTH, properties: { scale: '1.25' } },
    ],
  },
  {
    id: 'mockup-close-up',
    cat: '3d',
    name: 'Mockup Close-Up',
    description: 'Smooth push-in with slight 3D tilt',
    keyframes: [
      { position: 0, easing: TransitionEasing.AE_SMOOTH, properties: { scale: '1', translateZ: '0', rotateX: '0', rotateY: '0' } },
      { position: 100, easing: TransitionEasing.AE_SMOOTH, properties: { scale: '1.12', translateZ: '140', rotateX: '-4', rotateY: '3' } },
    ],
  },
  {
    id: 'mockup-orbit-left',
    cat: '3d',
    name: 'Orbit Left',
    description: 'Presentation-style left orbit with depth',
    keyframes: [
      { position: 0, easing: TransitionEasing.SINE_IN_OUT, properties: { translateX: '0', translateZ: '40', rotateY: '0', rotateX: '0' } },
      { position: 50, easing: TransitionEasing.SINE_IN_OUT, properties: { translateX: '-46', translateZ: '130', rotateY: '-10', rotateX: '-2' } },
      { position: 100, easing: TransitionEasing.SINE_IN_OUT, properties: { translateX: '0', translateZ: '40', rotateY: '0', rotateX: '0' } },
    ],
  },
  {
    id: 'deck-drift',
    cat: '3d',
    name: 'Deck Drift',
    description: 'Subtle cinematic drift for product slides',
    keyframes: [
      { position: 0, easing: TransitionEasing.LINEAR, properties: { translateX: '-24', translateY: '12', translateZ: '80', rotateY: '-5', rotateX: '-1' } },
      { position: 100, easing: TransitionEasing.LINEAR, properties: { translateX: '24', translateY: '-12', translateZ: '120', rotateY: '5', rotateX: '1' } },
    ],
  },
  {
    id: 'hero-punch',
    cat: '3d',
    name: 'Hero Punch',
    description: 'Quick impact zoom then settle',
    keyframes: [
      { position: 0, easing: TransitionEasing.AE_SMOOTH, properties: { scale: '0.95', translateZ: '0' } },
      { position: 35, easing: TransitionEasing.AE_SMOOTH, properties: { scale: '1.13', translateZ: '180', rotateX: '-3' } },
      { position: 100, easing: TransitionEasing.AE_SMOOTH, properties: { scale: '1.03', translateZ: '90', rotateX: '0' } },
    ],
  },
  {
    id: 'dark-spotlight',
    cat: 'fx',
    name: 'Dark Spotlight',
    description: 'Background fade + mild tint reveal',
    keyframes: [
      { position: 0, easing: TransitionEasing.AE_SMOOTH, properties: { backgroundColor: '#05070fdd', color: '#c7d2fe' } },
      { position: 100, easing: TransitionEasing.AE_SMOOTH, properties: { backgroundColor: '#00000000', color: '#ffffff' } },
    ],
  },
  {
    id: 'phone-app-swipe',
    cat: '3d',
    name: 'Phone Swipe Reveal',
    description: 'Quick vertical swipe feel with tiny tilt',
    keyframes: [
      { position: 0, easing: TransitionEasing.AE_SMOOTH, properties: { translateY: '80', translateZ: '70', rotateX: '-6', scale: '0.96' } },
      { position: 35, easing: TransitionEasing.AE_SMOOTH, properties: { translateY: '-24', translateZ: '180', rotateX: '2', scale: '1.06' } },
      { position: 100, easing: TransitionEasing.AE_SMOOTH, properties: { translateY: '0', translateZ: '120', rotateX: '0', scale: '1' } },
    ],
  },
  {
    id: 'phone-app-punch',
    cat: '3d',
    name: 'Phone App Punch In',
    description: 'Fast hero push for opening shots',
    keyframes: [
      { position: 0, easing: TransitionEasing.AE_SMOOTH, properties: { scale: '0.92', translateZ: '0', rotateY: '-4' } },
      { position: 30, easing: TransitionEasing.AE_SMOOTH, properties: { scale: '1.15', translateZ: '220', rotateY: '3' } },
      { position: 100, easing: TransitionEasing.AE_SMOOTH, properties: { scale: '1.02', translateZ: '120', rotateY: '0' } },
    ],
  },
  {
    id: 'phone-app-tilt-drift',
    cat: '3d',
    name: 'Phone Tilt Drift',
    description: 'Presentation camera drift for UI walkthroughs',
    keyframes: [
      { position: 0, easing: TransitionEasing.SINE_IN_OUT, properties: { translateX: '-30', translateY: '16', rotateY: '-6', rotateX: '-2', translateZ: '90' } },
      { position: 50, easing: TransitionEasing.SINE_IN_OUT, properties: { translateX: '24', translateY: '-8', rotateY: '6', rotateX: '1', translateZ: '135' } },
      { position: 100, easing: TransitionEasing.SINE_IN_OUT, properties: { translateX: '-12', translateY: '4', rotateY: '-2', rotateX: '0', translateZ: '110' } },
    ],
  },
  {
    id: 'phone-app-cta-hold',
    cat: 'fx',
    name: 'CTA Hold Focus',
    description: 'Hold/focus with subtle color emphasis',
    keyframes: [
      { position: 0, easing: TransitionEasing.AE_SMOOTH, properties: { scale: '1', color: '#ffffff', backgroundColor: 'rgba(12, 16, 32, 0)' } },
      { position: 45, easing: TransitionEasing.AE_SMOOTH, properties: { scale: '1.08', color: '#e0e7ff', backgroundColor: 'rgba(12, 16, 32, 0.32)' } },
      { position: 100, easing: TransitionEasing.AE_SMOOTH, properties: { scale: '1.08', color: '#e0e7ff', backgroundColor: 'rgba(12, 16, 32, 0.32)' } },
    ],
  },
  // ── Click / spring / wobble ────────────────────────────────
  // UI-motion feel: an impact early in the clip, then a damped settle back to
  // neutral, so they read on short (1-2s) clips. Two authoring rules keep them
  // honest: travel that should scale with the project uses xPercent/yPercent
  // (frame-relative) rather than raw pixels, and every animated property appears
  // in a CONTIGUOUS run of keyframes that ENDS on its neutral value. The second
  // one matters because the popover thumbnail renders the common snapshot via
  // interpolateKeyframes, which drops a property once no surrounding keyframe
  // carries it — ending on neutral makes that drop invisible.
  // Look-dev harness: html/keyframe-presets.html.
  {
    id: 'button-press',
    cat: 'spring',
    name: 'Button Press',
    description: 'Presses in, then springs back with an elastic settle',
    keyframes: [
      { position: 0,   easing: TransitionEasing.POWER2_IN,   properties: { scale: '1', yPercent: '0' } },
      { position: 7,   easing: TransitionEasing.ELASTIC_OUT, properties: { scale: '0.9', yPercent: '1.5' } },
      { position: 62,  easing: TransitionEasing.LINEAR,      properties: { scale: '1', yPercent: '0' } },
      { position: 100, easing: TransitionEasing.LINEAR,      properties: { scale: '1', yPercent: '0' } },
    ],
  },
  {
    id: 'button-tap-flash',
    cat: 'spring',
    name: 'Tap Flash',
    description: 'Click dip with a brightness pop on release',
    keyframes: [
      { position: 0,   easing: TransitionEasing.POWER2_IN,  properties: { scale: '1', brightness: '100' } },
      { position: 6,   easing: TransitionEasing.BACK_OUT,   properties: { scale: '0.93', brightness: '155' } },
      { position: 34,  easing: TransitionEasing.POWER2_OUT, properties: { scale: '1.05', brightness: '100' } },
      { position: 54,  easing: TransitionEasing.LINEAR,     properties: { scale: '1', brightness: '100' } },
      { position: 100, easing: TransitionEasing.LINEAR,     properties: { scale: '1', brightness: '100' } },
    ],
  },
  {
    id: 'pop-overshoot',
    cat: 'scale',
    outName: 'Pop Out',
    name: 'Pop Overshoot',
    description: 'Scales in past its size, dips, then settles',
    keyframes: [
      { position: 0,   easing: TransitionEasing.POWER2_OUT,    properties: { scale: '0.5', opacity: '0' } },
      { position: 26,  easing: TransitionEasing.POWER2_IN_OUT, properties: { scale: '1.14', opacity: '1' } },
      { position: 46,  easing: TransitionEasing.POWER2_IN_OUT, properties: { scale: '0.97' } },
      { position: 64,  easing: TransitionEasing.LINEAR,        properties: { scale: '1' } },
      { position: 100, easing: TransitionEasing.LINEAR,        properties: { scale: '1' } },
    ],
  },
  {
    id: 'spring-in',
    cat: 'spring',
    outName: 'Spring Out',
    name: 'Spring In',
    description: 'Elastic scale-up entrance with a ringing tail',
    keyframes: [
      { position: 0,   easing: TransitionEasing.POWER2_OUT,  properties: { scale: '0.35', opacity: '0' } },
      { position: 8,   easing: TransitionEasing.ELASTIC_OUT, properties: { scale: '0.62', opacity: '1' } },
      { position: 60,  easing: TransitionEasing.LINEAR,      properties: { scale: '1' } },
      { position: 100, easing: TransitionEasing.LINEAR,      properties: { scale: '1' } },
    ],
  },
  {
    id: 'rubber-wobble',
    cat: 'spring',
    name: 'Rubber Wobble',
    description: 'Damped rotation wobble, like a nudged switch',
    keyframes: [
      { position: 0,   easing: TransitionEasing.POWER2_OUT,    properties: { rotate: '0', scale: '1' } },
      { position: 8,   easing: TransitionEasing.POWER2_IN_OUT, properties: { rotate: '-9', scale: '1.04' } },
      { position: 22,  easing: TransitionEasing.POWER2_IN_OUT, properties: { rotate: '6.5', scale: '0.985' } },
      { position: 36,  easing: TransitionEasing.POWER2_IN_OUT, properties: { rotate: '-4', scale: '1.015' } },
      { position: 50,  easing: TransitionEasing.POWER2_IN_OUT, properties: { rotate: '2', scale: '0.995' } },
      { position: 64,  easing: TransitionEasing.POWER2_IN_OUT, properties: { rotate: '-0.8', scale: '1' } },
      { position: 78,  easing: TransitionEasing.LINEAR,        properties: { rotate: '0', scale: '1' } },
      { position: 100, easing: TransitionEasing.LINEAR,        properties: { rotate: '0', scale: '1' } },
    ],
  },
  {
    id: 'tap-nudge',
    cat: 'spring',
    name: 'Tap Nudge',
    description: 'Pushed down, lifts on release, drops back',
    keyframes: [
      { position: 0,   easing: TransitionEasing.POWER2_IN,     properties: { yPercent: '0', scale: '1' } },
      { position: 8,   easing: TransitionEasing.BACK_OUT,      properties: { yPercent: '2.6', scale: '0.96' } },
      { position: 42,  easing: TransitionEasing.POWER2_IN_OUT, properties: { yPercent: '-1.8', scale: '1.02' } },
      { position: 68,  easing: TransitionEasing.LINEAR,        properties: { yPercent: '0', scale: '1' } },
      { position: 100, easing: TransitionEasing.LINEAR,        properties: { yPercent: '0', scale: '1' } },
    ],
  },
  {
    id: 'whip-swing',
    cat: 'spring',
    outName: 'Whip Out',
    name: 'Whip Swing',
    description: 'Flies in on a whip, overshoots and rocks to a stop',
    keyframes: [
      { position: 0,   easing: TransitionEasing.POWER3_OUT,    properties: { xPercent: '-85', rotate: '-24', scale: '0.9', opacity: '0' } },
      { position: 26,  easing: TransitionEasing.POWER2_IN_OUT, properties: { xPercent: '7', rotate: '11', scale: '1.04', opacity: '1' } },
      { position: 44,  easing: TransitionEasing.POWER2_IN_OUT, properties: { xPercent: '-2.5', rotate: '-6', scale: '0.99' } },
      { position: 60,  easing: TransitionEasing.POWER2_IN_OUT, properties: { xPercent: '0.8', rotate: '3', scale: '1' } },
      { position: 74,  easing: TransitionEasing.POWER2_IN_OUT, properties: { xPercent: '0', rotate: '-1.2' } },
      { position: 88,  easing: TransitionEasing.LINEAR,        properties: { xPercent: '0', rotate: '0' } },
      { position: 100, easing: TransitionEasing.LINEAR,        properties: { xPercent: '0', rotate: '0' } },
    ],
  },
  {
    id: 'flick-drop',
    cat: 'spring',
    outName: 'Flick Up',
    name: 'Flick Drop',
    description: 'Drops in from above and bounces to a stop',
    keyframes: [
      { position: 0,   easing: TransitionEasing.BOUNCE_OUT, properties: { yPercent: '-75' } },
      { position: 66,  easing: TransitionEasing.LINEAR,     properties: { yPercent: '0' } },
      { position: 100, easing: TransitionEasing.LINEAR,     properties: { yPercent: '0' } },
    ],
  },
  {
    id: 'jelly-shake',
    cat: 'spring',
    name: 'Jelly Shake',
    description: 'Sharp horizontal shake that decays — reads as "no"',
    keyframes: [
      { position: 0,   easing: TransitionEasing.POWER1_IN_OUT, properties: { xPercent: '0', rotate: '0' } },
      { position: 8,   easing: TransitionEasing.POWER1_IN_OUT, properties: { xPercent: '3.2', rotate: '2.5' } },
      { position: 18,  easing: TransitionEasing.POWER1_IN_OUT, properties: { xPercent: '-2.5', rotate: '-2' } },
      { position: 28,  easing: TransitionEasing.POWER1_IN_OUT, properties: { xPercent: '1.7', rotate: '1.3' } },
      { position: 38,  easing: TransitionEasing.POWER1_IN_OUT, properties: { xPercent: '-1.1', rotate: '-0.8' } },
      { position: 48,  easing: TransitionEasing.POWER1_IN_OUT, properties: { xPercent: '0.6', rotate: '0.4' } },
      { position: 58,  easing: TransitionEasing.LINEAR,        properties: { xPercent: '0', rotate: '0' } },
      { position: 100, easing: TransitionEasing.LINEAR,        properties: { xPercent: '0', rotate: '0' } },
    ],
  },
  {
    id: 'heartbeat',
    cat: 'spring',
    name: 'Heartbeat',
    description: 'Double pulse, twice across the clip',
    keyframes: [
      { position: 0,   easing: TransitionEasing.POWER2_OUT, properties: { scale: '1' } },
      { position: 10,  easing: TransitionEasing.POWER2_IN,  properties: { scale: '1.09' } },
      { position: 20,  easing: TransitionEasing.POWER2_OUT, properties: { scale: '1' } },
      { position: 28,  easing: TransitionEasing.POWER2_IN,  properties: { scale: '1.06' } },
      { position: 40,  easing: TransitionEasing.LINEAR,     properties: { scale: '1' } },
      { position: 60,  easing: TransitionEasing.POWER2_OUT, properties: { scale: '1' } },
      { position: 70,  easing: TransitionEasing.POWER2_IN,  properties: { scale: '1.09' } },
      { position: 80,  easing: TransitionEasing.POWER2_OUT, properties: { scale: '1' } },
      { position: 88,  easing: TransitionEasing.POWER2_IN,  properties: { scale: '1.06' } },
      { position: 100, easing: TransitionEasing.LINEAR,     properties: { scale: '1' } },
    ],
  },
  {
    id: 'impact-punch',
    cat: 'fx',
    outName: 'Impact Out',
    name: 'Impact Punch',
    description: 'Slams in oversized and blurred, then locks in',
    keyframes: [
      { position: 0,   easing: TransitionEasing.POWER3_OUT, properties: { scale: '1.65', opacity: '0', blur: '16' } },
      { position: 26,  easing: TransitionEasing.BACK_OUT,   properties: { scale: '0.97', opacity: '1', blur: '0' } },
      { position: 54,  easing: TransitionEasing.LINEAR,     properties: { scale: '1' } },
      { position: 100, easing: TransitionEasing.LINEAR,     properties: { scale: '1' } },
    ],
  },
  {
    id: 'pendulum-swing',
    cat: 'spring',
    name: 'Pendulum Swing',
    description: 'Swings from its top edge and rocks to a stop',
    keyframes: [
      { position: 0,   transformOrigin: 'top', easing: TransitionEasing.POWER2_OUT,    properties: { rotate: '-22' } },
      { position: 22,  easing: TransitionEasing.POWER2_IN_OUT, properties: { rotate: '15' } },
      { position: 40,  easing: TransitionEasing.POWER2_IN_OUT, properties: { rotate: '-9' } },
      { position: 56,  easing: TransitionEasing.POWER2_IN_OUT, properties: { rotate: '5' } },
      { position: 70,  easing: TransitionEasing.POWER2_IN_OUT, properties: { rotate: '-2.5' } },
      { position: 84,  easing: TransitionEasing.LINEAR,        properties: { rotate: '0' } },
      { position: 100, easing: TransitionEasing.LINEAR,        properties: { rotate: '0' } },
    ],
  },
  // ── Wiggle / bounce / rotation family (10.9.182) ─────────────────────
  // Chosen from html/animation-presets-lab.html (50 candidates). These may carry
  // `fx` — a propertyKeyframeFx map keyed by track, the same shape the ƒx popover
  // writes — so a preset can ship a Bounce / Elastic / Wiggle expression instead
  // of a hand-keyed ring. applyPreset merges it onto the layer for the tracks it
  // replaces; the preview tile evaluates it too, so the thumbnail is the motion.
  {
    id: 'loose-wiggle',
    cat: 'wiggle',
    outName: 'Loose Wiggle Out',
    name: 'Loose Wiggle',
    description: 'Slides in from the right while the layer keeps a lazy rotational wobble the whole time',
    keyframes: [
      { position: 0, easing: TransitionEasing.AE_SMOOTH, properties: { xPercent: '100', rotate: '0' } },
      { position: 35, easing: TransitionEasing.AE_SMOOTH, properties: { xPercent: '0', rotate: '0' } },
      { position: 100, easing: TransitionEasing.LINEAR, properties: { xPercent: '0', rotate: '0' } },
    ],
    fx: {
      rotate: { type: 'wiggle', params: { amp: 4, freq: 2.5 } },
    },
  },
  {
    id: 'shiver',
    cat: 'wiggle',
    outName: 'Shiver Out',
    name: 'Shiver',
    description: 'Rises into place with a very fast, very small horizontal shiver',
    keyframes: [
      { position: 0, easing: TransitionEasing.AE_SMOOTH, properties: { yPercent: '60', opacity: '0', xPercent: '0' } },
      { position: 30, easing: TransitionEasing.AE_SMOOTH, properties: { yPercent: '0', opacity: '1', xPercent: '0' } },
      { position: 100, easing: TransitionEasing.LINEAR, properties: { yPercent: '0', opacity: '1', xPercent: '0' } },
    ],
    fx: {
      xPercent: { type: 'wiggle', params: { amp: 1, freq: 22 } },
    },
  },
  {
    id: 'float',
    cat: 'wiggle',
    outName: 'Float Away',
    name: 'Float',
    description: 'Pops in, then floats on a slow vertical bob and gentle tilt like it is underwater',
    keyframes: [
      { position: 0, easing: TransitionEasing.BACK_OUT, properties: { scale: '0.6', opacity: '0', yPercent: '0', rotate: '0' } },
      { position: 30, easing: TransitionEasing.BACK_OUT, properties: { scale: '1', opacity: '1', yPercent: '0', rotate: '0' } },
      { position: 100, easing: TransitionEasing.LINEAR, properties: { scale: '1', opacity: '1', yPercent: '0', rotate: '0' } },
    ],
    fx: {
      yPercent: { type: 'wiggle', params: { amp: 4, freq: 0.6 } },
      rotate: { type: 'wiggle', params: { amp: 2, freq: 0.4 } },
    },
  },
  {
    id: 'flicker-in',
    cat: 'wiggle',
    outName: 'Flicker Out',
    name: 'Flicker In',
    description: 'Opacity flickers like a failing neon tube while it fades up',
    keyframes: [
      { position: 0, easing: TransitionEasing.LINEAR, properties: { opacity: '0' } },
      { position: 45, easing: TransitionEasing.LINEAR, properties: { opacity: '1' } },
      { position: 100, easing: TransitionEasing.LINEAR, properties: { opacity: '1' } },
    ],
    fx: {
      opacity: { type: 'wiggle', params: { amp: 0.5, freq: 16 } },
    },
  },
  {
    id: 'earthquake',
    cat: 'wiggle',
    outName: 'Earthquake Out',
    name: 'Earthquake',
    description: 'Keyframed shake that decays — a hard rumble that calms down, with blur clearing',
    keyframes: [
      { position: 0, easing: TransitionEasing.LINEAR, properties: { xPercent: '0', yPercent: '0', blur: '8', opacity: '0' } },
      { position: 5, easing: TransitionEasing.LINEAR, properties: { xPercent: '-7', yPercent: '3', blur: '7', opacity: '1' } },
      { position: 10, easing: TransitionEasing.LINEAR, properties: { xPercent: '6', yPercent: '-4', blur: '6', opacity: '1' } },
      { position: 15, easing: TransitionEasing.LINEAR, properties: { xPercent: '-5', yPercent: '3', blur: '5', opacity: '1' } },
      { position: 20, easing: TransitionEasing.LINEAR, properties: { xPercent: '4', yPercent: '-2', blur: '4', opacity: '1' } },
      { position: 25, easing: TransitionEasing.LINEAR, properties: { xPercent: '-3', yPercent: '2', blur: '3', opacity: '1' } },
      { position: 30, easing: TransitionEasing.LINEAR, properties: { xPercent: '2', yPercent: '-1', blur: '2', opacity: '1' } },
      { position: 35, easing: TransitionEasing.LINEAR, properties: { xPercent: '-1', yPercent: '1', blur: '1', opacity: '1' } },
      { position: 40, easing: TransitionEasing.LINEAR, properties: { xPercent: '0', yPercent: '0', blur: '0', opacity: '1' } },
      { position: 100, easing: TransitionEasing.LINEAR, properties: { xPercent: '0', yPercent: '0', blur: '0', opacity: '1' } },
    ],
  },
  {
    id: 'tumble-drop',
    cat: 'bounce',
    outName: 'Tumble Up',
    name: 'Tumble Drop',
    description: 'Drops in tilted, bounces on landing while the tilt smoothly rights itself',
    keyframes: [
      { position: 0, easing: TransitionEasing.AE_SMOOTH, properties: { yPercent: '-120', rotate: '-35', opacity: '0' } },
      { position: 10, easing: TransitionEasing.AE_SMOOTH, properties: { yPercent: '-98', rotate: '-29', opacity: '1' } },
      { position: 55, easing: TransitionEasing.AE_SMOOTH, properties: { yPercent: '0', rotate: '0', opacity: '1' } },
      { position: 100, easing: TransitionEasing.LINEAR, properties: { yPercent: '0', rotate: '0', opacity: '1' } },
    ],
    fx: {
      yPercent: { type: 'bounce', params: { amp: 100, elasticity: 40, bounces: 3 } },
    },
  },
  {
    id: 'rubber-band',
    cat: 'spring',
    outName: 'Rubber Band Out',
    name: 'Rubber Band',
    description: 'Scales up and twangs like a plucked rubber band — several fast size wobbles',
    keyframes: [
      { position: 0, easing: TransitionEasing.LINEAR, properties: { scale: '0', opacity: '0' } },
      { position: 10, easing: TransitionEasing.LINEAR, properties: { scale: '0.22', opacity: '1' } },
      { position: 45, easing: TransitionEasing.LINEAR, properties: { scale: '1', opacity: '1' } },
      { position: 100, easing: TransitionEasing.LINEAR, properties: { scale: '1', opacity: '1' } },
    ],
    fx: {
      scale: { type: 'elastic', params: { amp: 100, freq: 2.2, decay: 5 } },
    },
  },
  {
    id: 'spring-twist',
    cat: 'spring',
    outName: 'Spring Untwist',
    name: 'Spring Twist',
    description: 'Rotation and scale spring in together — a twisting pop that rings into place',
    keyframes: [
      { position: 0, easing: TransitionEasing.LINEAR, properties: { rotate: '-90', scale: '0.5', opacity: '0' } },
      { position: 12, easing: TransitionEasing.LINEAR, properties: { rotate: '-66', scale: '0.63', opacity: '1' } },
      { position: 45, easing: TransitionEasing.LINEAR, properties: { rotate: '0', scale: '1', opacity: '1' } },
      { position: 100, easing: TransitionEasing.LINEAR, properties: { rotate: '0', scale: '1', opacity: '1' } },
    ],
    fx: {
      rotate: { type: 'elastic', params: { amp: 100, freq: 1.3, decay: 5 } },
      scale: { type: 'elastic', params: { amp: 100, freq: 1.3, decay: 5 } },
    },
  },
  {
    id: 'slingshot',
    cat: 'spring',
    outName: 'Slingshot Out',
    name: 'Slingshot',
    description: 'Keyframed: fired in from the left, overshoots right, one counter-swing, stops',
    keyframes: [
      { position: 0, easing: TransitionEasing.EXPO_OUT, properties: { xPercent: '-120' } },
      { position: 28, easing: TransitionEasing.POWER2_IN_OUT, properties: { xPercent: '10' } },
      { position: 46, easing: TransitionEasing.POWER2_IN_OUT, properties: { xPercent: '-3' } },
      { position: 60, easing: TransitionEasing.LINEAR, properties: { xPercent: '0' } },
      { position: 100, easing: TransitionEasing.LINEAR, properties: { xPercent: '0' } },
    ],
  },
  {
    id: 'pendulum-in',
    cat: 'spring',
    outName: 'Pendulum Out',
    name: 'Pendulum In',
    description: 'Lowered in from above hanging by its top edge, swinging side to side until still',
    keyframes: [
      { position: 0, transformOrigin: 'top', easing: TransitionEasing.AE_SMOOTH, properties: { rotate: '90', yPercent: '-100' } },
      { position: 30, easing: TransitionEasing.AE_SMOOTH, properties: { rotate: '41', yPercent: '0' } },
      { position: 55, easing: TransitionEasing.LINEAR, properties: { rotate: '0', yPercent: '0' } },
      { position: 100, easing: TransitionEasing.LINEAR, properties: { rotate: '0', yPercent: '0' } },
    ],
    fx: {
      rotate: { type: 'elastic', params: { amp: 100, freq: 2, decay: 4 } },
    },
  },
  {
    id: 'smooth-overshoot-rise',
    cat: 'spring',
    outName: 'Smooth Overshoot Drop',
    name: 'Smooth Overshoot Rise',
    description: 'Rises on the Smooth Overshoot curve — eases in, one soft overshoot, no ringing',
    keyframes: [
      { position: 0, easing: TransitionEasing.SMOOTH_OVERSHOOT, properties: { yPercent: '60', opacity: '0', scale: '0.92' } },
      { position: 55, easing: TransitionEasing.LINEAR, properties: { yPercent: '0', opacity: '1', scale: '1' } },
      { position: 100, easing: TransitionEasing.LINEAR, properties: { yPercent: '0', opacity: '1', scale: '1' } },
    ],
  },
  {
    id: 'spin-in',
    cat: 'rotate',
    outName: 'Spin Out',
    name: 'Spin In',
    description: 'A full turn while scaling up from nothing',
    keyframes: [
      { position: 0, easing: TransitionEasing.AE_SMOOTH, properties: { rotate: '-360', scale: '0', opacity: '0' } },
      { position: 15, easing: TransitionEasing.AE_SMOOTH, properties: { rotate: '-320', scale: '0.11', opacity: '1' } },
      { position: 55, easing: TransitionEasing.AE_SMOOTH, properties: { rotate: '0', scale: '1', opacity: '1' } },
      { position: 100, easing: TransitionEasing.LINEAR, properties: { rotate: '0', scale: '1', opacity: '1' } },
    ],
  },
  {
    id: 'twist-in',
    cat: 'rotate',
    outName: 'Twist Out',
    name: 'Twist In',
    description: 'Quarter turn with a Back Out overshoot on both the twist and the scale',
    keyframes: [
      { position: 0, easing: TransitionEasing.BACK_OUT, properties: { rotate: '-90', scale: '0.5', opacity: '0' } },
      { position: 15, easing: TransitionEasing.BACK_OUT, properties: { rotate: '-50', scale: '0.72', opacity: '1' } },
      { position: 40, easing: TransitionEasing.LINEAR, properties: { rotate: '0', scale: '1', opacity: '1' } },
      { position: 100, easing: TransitionEasing.LINEAR, properties: { rotate: '0', scale: '1', opacity: '1' } },
    ],
  },
  {
    id: 'roll-in',
    cat: 'rotate',
    outName: 'Roll Out',
    name: 'Roll In',
    description: 'Rolls in from the left like a wheel — one full rotation matched to the travel',
    keyframes: [
      { position: 0, easing: TransitionEasing.POWER2_OUT, properties: { xPercent: '-120', rotate: '-360' } },
      { position: 50, easing: TransitionEasing.POWER2_OUT, properties: { xPercent: '0', rotate: '0' } },
      { position: 100, easing: TransitionEasing.LINEAR, properties: { xPercent: '0', rotate: '0' } },
    ],
  },
  {
    id: 'tilt-settle',
    cat: 'rotate',
    outName: 'Tilt Away',
    name: 'Tilt Settle',
    description: 'Rises slightly tilted; the tilt springs level with one slow, wide overshoot',
    keyframes: [
      { position: 0, easing: TransitionEasing.AE_SMOOTH, properties: { rotate: '-14', yPercent: '40', opacity: '0' } },
      { position: 25, easing: TransitionEasing.AE_SMOOTH, properties: { rotate: '-8', yPercent: '18', opacity: '1' } },
      { position: 45, easing: TransitionEasing.AE_SMOOTH, properties: { rotate: '-3.5', yPercent: '0', opacity: '1' } },
      { position: 60, easing: TransitionEasing.AE_SMOOTH, properties: { rotate: '0', yPercent: '0', opacity: '1' } },
      { position: 100, easing: TransitionEasing.LINEAR, properties: { rotate: '0', yPercent: '0', opacity: '1' } },
    ],
    fx: {
      rotate: { type: 'elastic', params: { amp: 100, freq: 0.9, decay: 4 } },
    },
  },
  {
    id: 'wind-up-spin',
    cat: 'rotate',
    outName: 'Wind-Up Spin Out',
    name: 'Wind-Up Spin',
    description: 'Anticipation: winds back a little and shrinks, then whips a full turn the other way',
    keyframes: [
      { position: 0, easing: TransitionEasing.POWER2_IN, properties: { rotate: '0', scale: '1' } },
      { position: 18, easing: TransitionEasing.EXPO_OUT, properties: { rotate: '45', scale: '0.82' } },
      { position: 60, easing: TransitionEasing.POWER2_IN_OUT, properties: { rotate: '-360', scale: '1.06' } },
      { position: 72, easing: TransitionEasing.LINEAR, properties: { rotate: '-360', scale: '1' } },
      { position: 100, easing: TransitionEasing.LINEAR, properties: { rotate: '-360', scale: '1' } },
    ],
  },
];

export const KFP_CATEGORIES = [
  { id: 'slide', name: 'Slide & Move' },
  { id: 'inout', name: 'In and Out' },
  { id: 'scale', name: 'Scale & Pop' },
  { id: 'spring', name: 'Spring & Click' },
  { id: 'wiggle', name: 'Wiggle & Shake' },
  { id: 'bounce', name: 'Bounce & Drop' },
  { id: 'rotate', name: 'Rotate & Flip' },
  { id: '3d', name: '3D & Camera' },
  { id: 'fx', name: 'Blur & Color' },
];

// The window a preset fills by default when it is not the whole layer, in seconds.
export const KFP_DEFAULT_LENGTH = 1.5;

// The outro list is the intro list played backwards. Presets can name their reversed
// self (`outName`) where the entrance name would read wrong as an exit.
export function kfpVariants(presets, dir) {
  if (dir !== 'out') return presets;
  // An In and Out preset is already an entrance and an exit — reversing it would only swap its direction.
  return presets.map((preset) => {
    if (preset.inOut) return preset;
    const named = { ...preset, name: preset.outName || preset.name, description: preset.outDescription || 'Plays in reverse, as an exit' };
    // a directional preset is turned to its direction first and mirrored after (resolve() in the modal), so the
    // direction on the pad stays the way the layer travels — out
    return preset.directions ? { ...named, outro: true } : { ...named, keyframes: mirrorCommonKeyframes(preset.keyframes) };
  });
}

/** The preset as it is applied: a directional one turned to DIRECTION (its own base when not given); an Outro of one
 *  turned the opposite way and played backwards, so it leaves the way the direction points. (The editor's resolve.) */
export function resolvePresetVariant(preset, direction = null) {
  const allowed = directionsOf(preset);
  if (!allowed) return preset;
  const d = direction && allowed.includes(direction) ? direction : preset.baseDir;
  if (preset.outro) {
    const turned = directedKeyframes(preset, oppositeDirection(d));
    return { ...preset, keyframes: mirrorCommonKeyframes(turned.keyframes), fx: turned.fx };
  }
  return { ...preset, ...directedKeyframes(preset, d) };
}

/** A resolved PRESET written into a layer over [startPct, endPct] of it: { propertyKeyframes, propertyKeyframeFx,
 *  keyframeTransformOrigin } — the item's own tracks outside the range kept, its ƒx kept where the preset has none. */
export function applyKeyframePreset(item, preset, { startPct = 0, endPct = 100 } = {}) {
  const { propertyKeyframes: pk, transformOrigin } = commonToPropertyKeyframes(preset.keyframes);
  const scoped = scalePropertyKeyframesToRange(pk, startPct, endPct);
  const out = { propertyKeyframes: mergePropertyKeyframesInRange(item?.propertyKeyframes || {}, scoped, startPct, endPct) };
  if (preset.fx && typeof preset.fx === 'object') {
    const incoming = {};
    for (const [prop, cfg] of Object.entries(preset.fx)) if (Array.isArray(scoped[prop]) && scoped[prop].length > 0) incoming[prop] = cfg;
    if (Object.keys(incoming).length) out.propertyKeyframeFx = sanitizeKeyframeFxMap({ ...(item?.propertyKeyframeFx || {}), ...incoming });
  }
  if (transformOrigin && transformOrigin !== 'center') out.keyframeTransformOrigin = transformOrigin;
  return out;
}
