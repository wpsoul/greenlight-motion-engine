// GENERATED from html/finished/text-animators-lab/presets.js by tests/text-animators/port_from_lab.mjs.
// Do not edit here: change the lab catalogue, then run  node tests/text-animators/port_from_lab.mjs
import TXA from './textAnimators.js';

const factory = function (T) {
  const em = (v) => ({ em: v });
  const CATEGORIES = [
    { id: 'sweep', name: 'Sweep Reveal' },
    { id: 'kinetic', name: 'Kinetic' },
    { id: 'shape', name: 'Type on Shape' },
    { id: 'emphasis', name: 'Emphasis' },
    { id: 'loop', name: 'Loop' },
    { id: 'chars', name: 'Characters' },
    { id: 'voice', name: 'Voice' },
  ];
  const ACCENT = '#33efab';

  // sweep(): the classic AE travel — Offset runs the span across the whole text.
  // Sine Smooth by default: a stronger in-out lingers at both ends and races the
  // middle, which skips the very letters a sweep exists to show.
  const sweepIn = (width, dur, ease = 'Sine Smooth') => ({ offset: [[0, -width, ease], [dur, 100]] });
  const sweepAt = (width, from, dur, ease = 'Sine Smooth') => ({ offset: [[from, -width, ease], [from + dur, 100]] });
  // band(): the Sweep Reveal colour band, range 20–80 — Offset −80 parks it before
  // the text and +80 past it, so the text starts and ends in its own colour.
  // reverse = the band runs right to left.
  const BAND = { start: 20, end: 80, shape: 'smooth' };
  const band = (from, dur, ease = 'Sine Smooth', reverse = false) => ({ offset: [[from, reverse ? 80 : -80, ease], [from + dur, reverse ? -80 : 80]] });
  // Voice presets (captions): every unit takes its turn when it is spoken. Tiles and
  // the lab speak the sample with fakeVoice; the app reads the caption's timings.
  const VOICE_SAMPLE = 'Every word lands the moment it is spoken';
  const voice = (o) => ({ drive: 'voice', basedOn: 'words', ...o });
  // Kinetic presets (see the Kinetic block): Time animators that pop each line, word or
  // letter in from the layer's start and out at its end.
  const kIn = (basedOn, around, o) => ({ drive: 'time', animate: 'in', basedOn, around, ...o });
  const kOut = (basedOn, around, o) => ({ drive: 'time', animate: 'out', basedOn, around, ...o });
  const KIN_LINES = 'Make it\nmove like\nyou mean it';
  const KIN_WORDS = 'Every word swings into place';
  const KIN_LETTERS = 'LETTERS IN MOTION';
  const KIN_TILE = 'Text in\nmotion';
  const SWEEP_SAMPLE = 'Build a premium, modern sports-tech\nlanding page for a running performance\napp with a full-screen cinematic hero\nand a bold white headline about speed';

  // Glide Soft started as the AE "External Storage" word (GREEN PROJECT.aep, Pre-comp 18):
  // a hard typewriter (Start 0→100, Smoothness 0, AE's 33 %/100 % ease = 'AE In'; spaces
  // take no turn) and a blue blob matted to the letters that lags the typing and then
  // overtakes it (a band as wide as the text). Its timing and its glide are the owner's,
  // from the "Current" board's Project 1 (2026-10-17, a 2.4 s layer): typing 0–0.93 s,
  // the band 0.14–1.13 s, and the word gliding from +2.5 em to −2.5 em over the WHOLE
  // layer (that animator anchors to 'clip') on Smooth Glide — fast in, a slow pass
  // through the middle, fast on. The exit keeps going left and fades. Glide Soft Stop
  // glides on Glide Easing Stop instead: it all but stops in the middle.
  const glideSoft = (id, name, curve, description) => ({
    id, name, cat: 'sweep', sides: 'inOut', anchor: 'start', sample: 'External Storage',
    labLayer: { size: 110, weight: 400, align: 'left', stage: '#05070a' },
    description,
    animators: [
      { name: 'Type', range: { smooth: 0 },
        effects: [['opacity', { opacity: 0 }]],
        keys: { start: [[0, 0, 'AE In'], [0.93, 100]] } },
      { name: 'Blue band', range: { start: 0, end: 100, shape: 'smooth', easeHigh: 40 },
        effects: [['fill', { color: '#3e59ad' }]],
        keys: { offset: [[0.14, -58, 'Power1 Out'], [1.13, 101]] } },
      { name: 'Glide in', anchor: 'clip', range: { around: 'all' },
        effects: [['position', { x: em(2.5), y: 0 }]],
        keys: { amount: [[0, 100, curve], [100, -100]] } },
      { name: 'Glide out', range: { drive: 'time', animate: 'out', around: 'all', stagger: 0, duration: 0.5, curve: 'Power2 In' },
        effects: [['position', { x: em(-1.5), y: 0 }], ['opacity', { opacity: 0 }]] }],
  });

  const PRESETS = [
    // ── Sweep Reveal ──
    glideSoft('glide-soft', 'Glide Soft', 'Smooth Glide',
      'Letters type in under a chasing blue band as the word glides through, slow in the middle, then slides off to the left'),
    glideSoft('glide-soft-stop', 'Glide Soft Stop', 'Glide Easing Stop',
      'The same typing and band, but the word all but stops in the middle of its glide, then slides off to the left'),
    // The other ten: two animators each — the letters arrive one by one, fading in on the way
    // down, and a colour band (range 20–80, Smooth) runs across the text and
    // leaves it in the layer's own colour. They differ in how the letters land
    // and in how the band travels against the typing.
    { id: 'ember-type', name: 'Ember Type', cat: 'sweep', sides: 'in', anchor: 'start', sample: SWEEP_SAMPLE,
      labLayer: { size: 58, color: '#161411', stage: '#f7f0e4', align: 'left' },
      description: 'Letters type in falling softly; a warm band trails behind the typing',
      animators: [
        { name: 'Fade down', range: { end: 8, shape: 'rampUp' },
          effects: [['opacity', { opacity: 0 }]],
          keys: sweepIn(8, 1.8, 'Linear') },
        { name: 'Ember band', range: BAND,
          effects: [['fill', { color: '#e8892b' }]],
          keys: band(0.3, 2.7) }] },
    { id: 'molten-edge', name: 'Molten Edge', cat: 'sweep', sides: 'in', anchor: 'start', sample: SWEEP_SAMPLE,
      labLayer: { size: 58, align: 'left', stage: '#0d0c0b' },
      description: 'Letters land glowing hot at the typing edge and cool down behind it',
      animators: [
        { name: 'Fade down', range: { end: 14, shape: 'rampUp' },
          effects: [['position', { x: 0, y: em(-0.5) }], ['opacity', { opacity: 0 }]],
          keys: sweepIn(14, 1.6, 'Linear') },
        { name: 'Molten band', range: { ...BAND, easeHigh: 40 },
          effects: [['fill', { color: '#ffb02e' }], ['glow', { color: '#ff5a1f', size: em(0.18), strength: 110 }]],
          keys: band(0, 2.0, 'Linear') }] },
    { id: 'focus-type', name: 'Focus Type', cat: 'sweep', sides: 'in', anchor: 'start', sample: SWEEP_SAMPLE,
      labLayer: { size: 58, align: 'left' },
      description: 'A long soft wave of letters falls out of a blur under a cool gradient',
      animators: [
        { name: 'Fade down', range: { end: 32, shape: 'rampUp' },
          effects: [['position', { x: 0, y: em(-0.25) }], ['blur', { amount: em(0.12) }], ['opacity', { opacity: 0 }]],
          keys: sweepIn(32, 1.9) },
        { name: 'Cool band', range: BAND,
          effects: [['gradient', { colors: ['#7cf5ff', '#b36bff'], angle: 0, span: 'text' }]],
          keys: band(0.4, 2.5) }] },
    { id: 'tumble-type', name: 'Tumble Type', cat: 'sweep', sides: 'in', anchor: 'start', sample: SWEEP_SAMPLE,
      labLayer: { size: 58, align: 'left' },
      description: 'Letters tumble down into place, then a lime band runs over the finished text',
      animators: [
        { name: 'Tumble down', range: { end: 12, shape: 'rampUp', easeLow: 50 },
          effects: [['position', { x: 0, y: em(-0.8) }], ['rotation', { angle: -30 }], ['opacity', { opacity: 0 }]],
          keys: sweepIn(12, 1.4) },
        { name: 'Lime band', range: BAND,
          effects: [['fill', { color: '#c4f53d' }]],
          keys: band(1.1, 1.6) }] },
    { id: 'flap-down', name: 'Flap Down', cat: 'sweep', sides: 'in', anchor: 'start', sample: SWEEP_SAMPLE,
      labLayer: { size: 58, align: 'left' },
      layer: { pivotY: -100 },
      description: 'Letters swing down from a hinge at their top edge under an amber band',
      animators: [
        { name: 'Flap down', range: { end: 16, shape: 'rampUp' },
          effects: [['rotate3d', { x: 90, y: 0, perspective: em(8) }], ['position', { x: 0, y: em(-0.12) }], ['opacity', { opacity: 0 }]],
          keys: sweepIn(16, 1.7) },
        { name: 'Amber band', range: BAND,
          effects: [['fill', { color: '#ffc247' }]],
          keys: band(0.35, 2.4) }] },
    { id: 'drop-swell', name: 'Drop Swell', cat: 'sweep', sides: 'in', anchor: 'start', sample: SWEEP_SAMPLE,
      labLayer: { size: 58, align: 'left' },
      description: 'Letters drop hard into place; a coral band lifts and swells them as it passes',
      animators: [
        { name: 'Drop', range: { end: 10, shape: 'rampUp', easeLow: 60 },
          effects: [['position', { x: 0, y: em(-1.2) }], ['opacity', { opacity: 0 }]],
          keys: sweepIn(10, 1.5, 'Ease Out') },
        { name: 'Swell band', range: BAND,
          effects: [['fill', { color: '#ff6b5a' }], ['scale', { scale: 112 }], ['position', { x: 0, y: em(-0.12) }]],
          keys: band(0.3, 2.4) }] },
    { id: 'rain-type', name: 'Rain Type', cat: 'sweep', sides: 'in', anchor: 'start', sample: SWEEP_SAMPLE,
      labLayer: { size: 58, align: 'left' },
      description: 'Letters fall in at random like rain while a blue band runs left to right',
      animators: [
        { name: 'Rain', range: { end: 18, shape: 'rampUp', randomize: true, seed: 11 },
          effects: [['position', { x: 0, y: em(-0.7) }], ['opacity', { opacity: 0 }]],
          keys: sweepIn(18, 1.8, 'Linear') },
        { name: 'Blue band', range: BAND,
          effects: [['fill', { color: '#4fc3ff' }]],
          keys: band(0.4, 2.4) }] },
    { id: 'counter-sweep', name: 'Counter Sweep', cat: 'sweep', sides: 'in', anchor: 'start', sample: SWEEP_SAMPLE,
      labLayer: { size: 58, align: 'left' },
      description: 'Letters type in left to right while a pink band runs back against them',
      animators: [
        { name: 'Fade down', range: { end: 12, shape: 'rampUp' },
          effects: [['position', { x: 0, y: em(-0.35) }], ['opacity', { opacity: 0 }]],
          keys: sweepIn(12, 1.5) },
        { name: 'Pink band', range: BAND,
          effects: [['fill', { color: '#ff5ea8' }]],
          keys: band(0.7, 2.0, 'Sine Smooth', true) }] },
    { id: 'sunset-shrink', name: 'Sunset Shrink', cat: 'sweep', sides: 'in', anchor: 'start', sample: SWEEP_SAMPLE,
      labLayer: { size: 58, align: 'left' },
      description: 'Big letters shrink down into place; a band paints each one top to bottom in sunset colours',
      animators: [
        { name: 'Shrink down', range: { end: 14, shape: 'rampUp' },
          effects: [['scale', { scale: 190 }], ['position', { x: 0, y: em(-0.3) }], ['opacity', { opacity: 0 }]],
          keys: sweepIn(14, 1.6) },
        { name: 'Sunset band', range: { ...BAND, easeHigh: 40 },
          effects: [['gradient', { colors: ['#ffd36b', '#ff7a45', '#e8336d'], angle: 90, span: 'unit' }]],
          keys: band(0.3, 2.5) }] },
    { id: 'boomerang', name: 'Boomerang', cat: 'sweep', sides: 'in', anchor: 'start', sample: SWEEP_SAMPLE,
      labLayer: { size: 58, align: 'left' },
      description: 'Letters glide down at a slant; a violet band runs out with the typing and swings back',
      animators: [
        { name: 'Glide down', range: { end: 16, shape: 'rampUp' },
          effects: [['position', { x: em(0.45), y: em(-0.45) }], ['skew', { skew: -24, axis: 0 }], ['opacity', { opacity: 0 }]],
          keys: sweepIn(16, 1.5) },
        { name: 'Violet band', range: BAND,
          effects: [['fill', { color: '#a77bff' }]],
          keys: { offset: [[0.1, -80, 'Sine Smooth'], [1.6, 40, 'Sine Smooth'], [3.0, -80]] } }] },

    // ── Kinetic ──
    // Swing Pop is a Jitter export ported to the frame (html/swing-pop-lab): every word
    // grows out of its own centre (Transform around ▸ Word), −25° → +5° → 0° and
    // 0 → 120 → 100 % on Overshoot, and at the end winds up (+9.5°, 138 %) and pops on
    // Anticipate, last word first. The twenty after it keep that shape — two Time
    // animators, an entrance from the layer's start and an exit that ends with it, no keys
    // (the modal's Speed scales both) — and change what moves: the pivot (a word's centre,
    // its top, bottom or left edge, its corner), the unit (words or letters: never a whole
    // line, the owner's rule of 2026-10-17 — a line turning as one block read as a tilted
    // slab), the order, 2D or 3D, and the curve.
    { id: 'swing-pop', name: 'Swing Pop', cat: 'kinetic', sides: 'inOut', anchor: 'drive', sample: 'Plants.\nPeople.\nPlanet.', tile: KIN_TILE,
      labLayer: { size: 220, weight: 800, lineHeight: 0.8, color: '#fde208', stage: '#736e4e' },
      description: 'Words swing out of their own centre and overshoot into place; at the end they wind up and pop away',
      animators: [
        { name: 'Swing in', range: kIn('words', 'word', { stagger: 0.04, duration: 0.8, curve: 'Overshoot' }),
          effects: [['rotation', { angle: -25 }], ['scale', { scale: 0 }]] },
        { name: 'Pop out', range: kOut('words', 'word', { order: 'backward', stagger: 0.035, duration: 0.75, curve: 'Anticipate' }),
          effects: [['rotation', { angle: -25 }], ['scale', { scale: 0 }]] }] },
    { id: 'word-swing', name: 'Word Swing', cat: 'kinetic', sides: 'inOut', anchor: 'drive', sample: KIN_WORDS,
      labLayer: { size: 110 },
      description: 'Words pop out of the middle of the text in random order and swing round into place; at the end they wind up and pop back',
      animators: [
        { name: 'Swing in', range: kIn('words', 'all', { order: 'random', seed: 3, stagger: 0.06, duration: 0.75, curve: 'Overshoot' }),
          effects: [['rotation', { angle: 35 }], ['scale', { scale: 0 }]] },
        { name: 'Pop out', range: kOut('words', 'all', { order: 'random', seed: 7, stagger: 0.03, duration: 0.7, curve: 'Anticipate' }),
          effects: [['rotation', { angle: 35 }], ['scale', { scale: 0 }]] }] },
    { id: 'letter-vortex', name: 'Letter Vortex', cat: 'kinetic', sides: 'inOut', anchor: 'drive', sample: KIN_LETTERS,
      labLayer: { size: 140 },
      description: 'Letters spiral out of the centre of the text one by one; at the end they spin back into it',
      animators: [
        { name: 'Spiral in', range: kIn('charsNoSpace', 'all', { stagger: 0.02, duration: 0.9, curve: 'Overshoot' }),
          effects: [['rotation', { angle: -120 }], ['scale', { scale: 0 }]] },
        { name: 'Spiral out', range: kOut('charsNoSpace', 'all', { order: 'random', seed: 4, stagger: 0.012, duration: 0.6, curve: 'Anticipate' }),
          effects: [['rotation', { angle: 120 }], ['scale', { scale: 0 }]] }] },
    { id: 'center-burst', name: 'Center Burst', cat: 'kinetic', sides: 'inOut', anchor: 'drive', sample: KIN_LINES, tile: KIN_TILE,
      labLayer: { size: 150, lineHeight: 0.95 },
      description: 'The middle words burst out first and the others follow, wobbling into place; at the end they shrink away from the outside in',
      animators: [
        { name: 'Burst in', range: kIn('words', 'word', { order: 'center', stagger: 0.08, duration: 1.1, curve: 'Elastic' }),
          effects: [['scale', { scale: 0 }]] },
        { name: 'Shrink out', range: kOut('words', 'word', { order: 'edges', stagger: 0.05, duration: 0.5, curve: 'Back In' }),
          effects: [['scale', { scale: 0 }]] }] },
    { id: 'pendulum', name: 'Pendulum', cat: 'kinetic', sides: 'inOut', anchor: 'drive', sample: KIN_LINES, tile: KIN_TILE,
      labLayer: { size: 150, lineHeight: 0.95 },
      layer: { pivotY: -100 },
      description: 'Words hang from their top edge and swing in like a pendulum until they settle; at the end they swing away',
      animators: [
        { name: 'Swing in', range: kIn('words', 'word', { stagger: 0.08, duration: 1.5, curve: 'Elastic' }),
          effects: [['rotation', { angle: 40 }], ['opacity', { opacity: 0 }]] },
        { name: 'Swing out', range: kOut('words', 'word', { order: 'backward', stagger: 0.04, duration: 0.7, curve: 'Anticipate' }),
          effects: [['rotation', { angle: -40 }], ['opacity', { opacity: 0 }]] }] },
    { id: 'spin-pop', name: 'Spin Pop', cat: 'kinetic', sides: 'inOut', anchor: 'drive', sample: KIN_LINES, tile: KIN_TILE,
      labLayer: { size: 150, lineHeight: 0.95 },
      description: 'Each word spins a full turn in place as it grows in; at the end each spins back out',
      animators: [
        { name: 'Spin in', range: kIn('words', 'word', { stagger: 0.09, duration: 0.9, curve: 'Back Out' }),
          effects: [['rotation', { angle: -360 }], ['scale', { scale: 0 }]] },
        { name: 'Spin out', range: kOut('words', 'word', { order: 'backward', stagger: 0.05, duration: 0.55, curve: 'Back In' }),
          effects: [['rotation', { angle: 360 }], ['scale', { scale: 0 }]] }] },
    { id: 'domino', name: 'Domino', cat: 'kinetic', sides: 'inOut', anchor: 'drive', sample: KIN_LINES, tile: KIN_TILE,
      labLayer: { size: 150, lineHeight: 0.95 },
      layer: { pivotX: -100, pivotY: 100 },
      description: 'Words stand up on their bottom-left corner and drop flat with a bounce, one after another; at the end they fall over',
      animators: [
        { name: 'Drop in', range: kIn('words', 'word', { stagger: 0.14, duration: 1.0, curve: 'Bounce Out' }),
          effects: [['rotation', { angle: -90 }], ['opacity', { opacity: 0 }]] },
        { name: 'Fall out', range: kOut('words', 'word', { stagger: 0.08, duration: 0.6, curve: 'Power2 In' }),
          effects: [['rotation', { angle: 90 }], ['opacity', { opacity: 0 }]] }] },
    { id: 'flip-pop', name: 'Flip Pop', cat: 'kinetic', sides: 'inOut', anchor: 'drive', sample: KIN_LINES, tile: KIN_TILE,
      labLayer: { size: 150, lineHeight: 0.95 },
      description: 'Words flip up into view in 3D, past flat and back; at the end they tip back and flip away',
      animators: [
        { name: 'Flip in', range: kIn('words', 'word', { stagger: 0.08, duration: 0.8, curve: 'Overshoot' }),
          effects: [['rotate3d', { x: -90, y: 0, perspective: em(6) }], ['opacity', { opacity: 0 }]] },
        { name: 'Flip out', range: kOut('words', 'word', { order: 'backward', stagger: 0.05, duration: 0.6, curve: 'Anticipate' }),
          effects: [['rotate3d', { x: 90, y: 0, perspective: em(6) }], ['opacity', { opacity: 0 }]] }] },
    { id: 'card-turn', name: 'Card Turn', cat: 'kinetic', sides: 'inOut', anchor: 'drive', sample: KIN_WORDS,
      labLayer: { size: 110 },
      description: 'Words turn to face you like cards, one by one, overshooting the turn; at the end they turn away',
      animators: [
        { name: 'Turn in', range: kIn('words', 'word', { stagger: 0.07, duration: 0.8, curve: 'Overshoot' }),
          effects: [['rotate3d', { x: 0, y: 90, perspective: em(5) }], ['opacity', { opacity: 0 }]] },
        { name: 'Turn out', range: kOut('words', 'word', { stagger: 0.04, duration: 0.6, curve: 'Anticipate' }),
          effects: [['rotate3d', { x: 0, y: -90, perspective: em(5) }], ['opacity', { opacity: 0 }]] }] },
    { id: 'slam-zoom', name: 'Slam Zoom', cat: 'kinetic', sides: 'inOut', anchor: 'drive', sample: KIN_LINES, tile: KIN_TILE,
      labLayer: { size: 150, lineHeight: 0.95 },
      description: 'Words slam down from huge, punch past their size and settle; at the end they fly back at the camera',
      animators: [
        { name: 'Slam in', range: kIn('words', 'word', { stagger: 0.1, duration: 0.7, curve: 'Overshoot' }),
          effects: [['scale', { scale: 300 }], ['blur', { amount: em(0.06) }], ['opacity', { opacity: 0 }]] },
        { name: 'Zoom out', range: kOut('words', 'word', { order: 'backward', stagger: 0.05, duration: 0.45, curve: 'Expo In' }),
          effects: [['scale', { scale: 300 }], ['blur', { amount: em(0.06) }], ['opacity', { opacity: 0 }]] }] },
    { id: 'orbit', name: 'Orbit', cat: 'kinetic', sides: 'inOut', anchor: 'drive', sample: KIN_LINES, tile: KIN_TILE,
      labLayer: { size: 150, lineHeight: 0.95 },
      description: 'Words turn in from a third of a turn away and ease into place; at the end they turn off',
      animators: [
        { name: 'Orbit in', range: kIn('words', 'word', { stagger: 0.1, duration: 1.1, curve: 'Smooth Overshoot' }),
          effects: [['rotation', { angle: -110 }], ['opacity', { opacity: 0 }]] },
        { name: 'Orbit out', range: kOut('words', 'word', { order: 'backward', stagger: 0.05, duration: 0.7, curve: 'Anticipate' }),
          effects: [['rotation', { angle: 110 }], ['opacity', { opacity: 0 }]] }] },
    { id: 'fan-deal', name: 'Fan Deal', cat: 'kinetic', sides: 'inOut', anchor: 'drive', sample: KIN_LINES, tile: KIN_TILE,
      labLayer: { size: 150, lineHeight: 0.95 },
      layer: { pivotY: 100 },
      description: 'Words fan up from their bottom edge like cards dealt from a hand, last word first; at the end they fan away',
      animators: [
        { name: 'Deal in', range: kIn('words', 'word', { order: 'backward', stagger: 0.09, duration: 0.9, curve: 'Overshoot' }),
          effects: [['rotation', { angle: -70 }], ['opacity', { opacity: 0 }]] },
        { name: 'Fan out', range: kOut('words', 'word', { stagger: 0.05, duration: 0.6, curve: 'Anticipate' }),
          effects: [['rotation', { angle: 70 }], ['opacity', { opacity: 0 }]] }] },
    { id: 'whip', name: 'Whip', cat: 'kinetic', sides: 'inOut', anchor: 'drive', sample: KIN_LINES, tile: KIN_TILE,
      labLayer: { size: 150, lineHeight: 0.95 },
      description: 'Words whip in from the left leaning into the move, snap past and settle; at the end they lean back and whip off to the right',
      animators: [
        { name: 'Whip in', range: kIn('words', 'word', { stagger: 0.07, duration: 0.7, curve: 'Overshoot' }),
          effects: [['position', { x: em(-1.6), y: 0 }], ['skew', { skew: 40, axis: 0 }], ['opacity', { opacity: 0 }]] },
        { name: 'Whip out', range: kOut('words', 'word', { stagger: 0.04, duration: 0.55, curve: 'Anticipate' }),
          effects: [['position', { x: em(1.6), y: 0 }], ['skew', { skew: -40, axis: 0 }], ['opacity', { opacity: 0 }]] }] },
    { id: 'rubber-letters', name: 'Rubber Letters', cat: 'kinetic', sides: 'inOut', anchor: 'drive', sample: KIN_LETTERS,
      labLayer: { size: 140 },
      description: 'Letters spring out of thin slivers and wobble like rubber; at the end they stretch tall and squash flat',
      animators: [
        { name: 'Stretch in', range: kIn('charsNoSpace', 'char', { stagger: 0.03, duration: 0.9, curve: 'Elastic' }),
          effects: [['scale', { scale: 100, x: 0, y: 250 }]] },
        { name: 'Squash out', range: kOut('charsNoSpace', 'char', { stagger: 0.015, duration: 0.5, curve: 'Anticipate' }),
          effects: [['scale', { scale: 100, x: 250, y: 0 }]] }] },
    { id: 'pop-letters', name: 'Pop Letters', cat: 'kinetic', sides: 'inOut', anchor: 'drive', sample: KIN_LETTERS,
      labLayer: { size: 140 },
      description: 'Letters pop up in random order, each with a little twist; at the end they swell and pop away at random',
      animators: [
        { name: 'Pop in', range: kIn('charsNoSpace', 'char', { order: 'random', seed: 5, stagger: 0.025, duration: 0.6, curve: 'Overshoot' }),
          effects: [['scale', { scale: 0 }], ['rotation', { angle: -40 }]] },
        { name: 'Pop out', range: kOut('charsNoSpace', 'char', { order: 'random', seed: 9, stagger: 0.012, duration: 0.5, curve: 'Anticipate' }),
          effects: [['scale', { scale: 0 }], ['rotation', { angle: 40 }]] }] },
    { id: 'drop-swing', name: 'Drop Swing', cat: 'kinetic', sides: 'inOut', anchor: 'drive', sample: KIN_WORDS,
      labLayer: { size: 110 },
      description: 'Words drop in tilted from above and bounce as they land; at the end they fall out of the frame',
      animators: [
        { name: 'Drop in', range: kIn('words', 'word', { stagger: 0.08, duration: 0.9, curve: 'Bounce Out' }),
          effects: [['position', { x: 0, y: em(-1.2) }], ['rotation', { angle: 25 }], ['opacity', { opacity: 0 }]] },
        { name: 'Fall out', range: kOut('words', 'word', { stagger: 0.04, duration: 0.5, curve: 'Power2 In' }),
          effects: [['position', { x: 0, y: em(1.2) }], ['rotation', { angle: -25 }], ['opacity', { opacity: 0 }]] }] },
    { id: 'coin-spin', name: 'Coin Spin', cat: 'kinetic', sides: 'inOut', anchor: 'drive', sample: KIN_LETTERS,
      labLayer: { size: 140 },
      description: 'Letters spin in like coins, one after another, and rock to a stop; at the end they spin away',
      animators: [
        { name: 'Spin in', range: kIn('charsNoSpace', 'char', { stagger: 0.035, duration: 0.8, curve: 'Overshoot' }),
          effects: [['rotate3d', { x: 0, y: 180, perspective: em(4) }], ['opacity', { opacity: 0 }]] },
        { name: 'Spin out', range: kOut('charsNoSpace', 'char', { stagger: 0.015, duration: 0.55, curve: 'Anticipate' }),
          effects: [['rotate3d', { x: 0, y: -180, perspective: em(4) }], ['opacity', { opacity: 0 }]] }] },
    { id: 'converge', name: 'Converge', cat: 'kinetic', sides: 'inOut', anchor: 'drive', sample: KIN_LINES, tile: KIN_TILE,
      labLayer: { size: 150, lineHeight: 0.95 },
      description: 'Words shrink down from far bigger, the outer ones first, and settle; at the end they burst outward',
      animators: [
        { name: 'Close in', range: kIn('words', 'word', { order: 'edges', stagger: 0.08, duration: 0.9, curve: 'Expo Out' }),
          effects: [['scale', { scale: 260 }], ['opacity', { opacity: 0 }]] },
        { name: 'Burst out', range: kOut('words', 'word', { order: 'center', stagger: 0.05, duration: 0.5, curve: 'Expo In' }),
          effects: [['scale', { scale: 260 }], ['opacity', { opacity: 0 }]] }] },
    { id: 'roll-in', name: 'Roll In', cat: 'kinetic', sides: 'inOut', anchor: 'drive', sample: KIN_LETTERS,
      labLayer: { size: 140 },
      description: 'Letters roll in from the right like wheels and rock back into place; at the end they roll off to the left',
      animators: [
        { name: 'Roll in', range: kIn('charsNoSpace', 'char', { stagger: 0.03, duration: 0.8, curve: 'Overshoot' }),
          effects: [['position', { x: em(1.2), y: 0 }], ['rotation', { angle: 200 }], ['opacity', { opacity: 0 }]] },
        { name: 'Roll out', range: kOut('charsNoSpace', 'char', { stagger: 0.015, duration: 0.6, curve: 'Back In' }),
          effects: [['position', { x: em(-1.2), y: 0 }], ['rotation', { angle: -200 }], ['opacity', { opacity: 0 }]] }] },
    { id: 'door-swing', name: 'Door Swing', cat: 'kinetic', sides: 'inOut', anchor: 'drive', sample: KIN_LINES, tile: KIN_TILE,
      labLayer: { size: 150, lineHeight: 0.95 },
      layer: { pivotX: -100 },
      description: 'Words swing open in 3D on a hinge at their left edge, past flat and back; at the end they swing shut',
      animators: [
        { name: 'Swing open', range: kIn('words', 'word', { stagger: 0.07, duration: 0.9, curve: 'Overshoot' }),
          effects: [['rotate3d', { x: 0, y: 80, perspective: em(10) }], ['opacity', { opacity: 0 }]] },
        { name: 'Swing shut', range: kOut('words', 'word', { stagger: 0.04, duration: 0.6, curve: 'Anticipate' }),
          effects: [['rotate3d', { x: 0, y: -80, perspective: em(10) }], ['opacity', { opacity: 0 }]] }] },

    // ── Type on Shape ──
    // The typing animator carries a Highlight box set to Behind ▸ Revealed, so the
    // shape grows with the letters on one set of keys. Per line = a bar per row,
    // Block = one card that widens and then grows a line taller. `tile` = the
    // modal tile's text (Block needs two rows to show). They differ in how the
    // text arrives: soft rising wave, dropping wave, word pops, sliding lines,
    // crisp letters, and a backspace exit.
    { id: 'pill-type', name: 'Pill Type', cat: 'shape', sides: 'in', anchor: 'start', sample: 'Type on a pill\nthat grows with you',
      labLayer: { size: 64, align: 'left', stage: '#0d1013' },
      description: 'Letters rise in a soft wave onto a pill that stretches along each line',
      animators: [
        { name: 'Type', range: { end: 6, shape: 'rampUp' },
          effects: [['position', { x: 0, y: em(0.25) }], ['opacity', { opacity: 0 }],
            ['box', { color: ACCENT, behind: 'revealed', padX: em(0.28), padY: em(0.1), radius: em(0.6) }]],
          keys: sweepIn(6, 1.6, 'Linear') },
        { name: 'Ink', range: {},
          effects: [['fill', { color: '#07130e' }]] }] },
    { id: 'card-type', name: 'Card Type', cat: 'shape', sides: 'in', anchor: 'start', tile: 'Text in\nmotion',
      sample: 'A card that grows\nwith every letter\nyou type',
      labLayer: { size: 58, align: 'left', stage: '#2b2f36' },
      description: 'Letters drop in while a white card widens with them, then grows a line taller',
      animators: [
        { name: 'Type', range: { end: 12, shape: 'rampUp' },
          effects: [['position', { x: 0, y: em(-0.35) }], ['opacity', { opacity: 0 }],
            ['box', { color: '#ffffff', behind: 'revealed', shape: 'block', padX: em(0.45), padY: em(0.3), radius: em(0.3) }]],
          keys: sweepIn(12, 2.0, 'Linear') },
        { name: 'Ink', range: {},
          effects: [['fill', { color: '#16181d' }]] }] },
    { id: 'word-bars', name: 'Word Bars', cat: 'shape', sides: 'in', anchor: 'start', sample: 'Every word lands\non its own bar',
      labLayer: { size: 64, align: 'left', stage: '#101010' },
      description: 'Words pop up one at a time and the red bar stretches to take each one',
      animators: [
        { name: 'Words', range: { basedOn: 'words', smooth: 100 },
          effects: [['scale', { scale: 40 }], ['opacity', { opacity: 0 }],
            ['box', { color: '#ff3d57', behind: 'revealed', padX: em(0.16), padY: em(0.06), radius: em(0.06) }]],
          keys: { start: [[0, 0, 'Linear'], [1.6, 100]] } }] },
    { id: 'line-stack', name: 'Word Stack', cat: 'shape', sides: 'in', anchor: 'start', tile: 'Text in\nmotion',
      sample: 'Word by word\nthe card grows\nto fit the text',
      labLayer: { size: 60, align: 'left', stage: '#0f0d17' },
      description: 'Words slide in from the left one at a time and the card grows to take each one',
      animators: [
        { name: 'Words', range: { basedOn: 'words', smooth: 100 },
          effects: [['position', { x: em(-0.8), y: 0 }], ['opacity', { opacity: 0 }],
            ['box', { color: '#6a3df0', behind: 'revealed', shape: 'block', padX: em(0.4), padY: em(0.22), radius: em(0.22) }]],
          keys: { start: [[0, 0, 'Sine Smooth'], [1.4, 100]] } }] },
    { id: 'marker-type', name: 'Marker Type', cat: 'shape', sides: 'in', anchor: 'start', sample: 'A marker that keeps\nup with the typing',
      labLayer: { size: 62, align: 'left', stage: '#f4f1ea' },
      description: 'Crisp letters type in one by one, a yellow marker running right at the edge',
      animators: [
        { name: 'Type', range: { smooth: 100 },
          effects: [['opacity', { opacity: 0 }],
            ['box', { color: '#ffe14d', behind: 'revealed', padX: em(0.06), padY: em(0.02), radius: em(0.03) }]],
          keys: { start: [[0, 0, 'Linear'], [1.8, 100]] } },
        { name: 'Ink', range: {},
          effects: [['fill', { color: '#141414' }]] }] },
    { id: 'card-erase', name: 'Card Erase', cat: 'shape', sides: 'out', anchor: 'end', tile: 'Text in\nmotion',
      sample: 'Backspace takes\nthe card with it',
      labLayer: { size: 60, align: 'left', stage: '#14161a' },
      description: 'Letters shrink away from the end like a backspace and the card shrinks back with them',
      animators: [
        { name: 'Erase', range: { smooth: 100 },
          effects: [['scale', { scale: 50 }], ['opacity', { opacity: 0 }],
            ['box', { color: '#ff6a3d', behind: 'revealed', shape: 'block', padX: em(0.4), padY: em(0.25), radius: em(0.25) }]],
          keys: { start: [[-1.4, 100, 'Linear'], [0, 0]] } }] },

    // ── Emphasis ──
    { id: 'colour-sweep', name: 'Colour Sweep', cat: 'emphasis', sides: 'once', anchor: 'start', sample: 'Every letter, one by one',
      description: 'A raised yellow band travels across the letters once',
      animators: [{ name: 'Colour sweep', range: { end: 14, shape: 'smooth' },
        effects: [['fill', { color: '#ffd84d' }], ['scale', { scale: 118 }], ['position', { x: 0, y: em(-0.15) }]],
        keys: sweepAt(14, 0.2, 1.6) }] },
    { id: 'glow-pass', name: 'Glow Pass', cat: 'emphasis', sides: 'once', anchor: 'start', sample: 'Light passes through',
      description: 'A bright glowing band passes across the text once',
      animators: [{ name: 'Glow pass', range: { end: 26, shape: 'triangle' },
        effects: [['fill', { color: '#f2ffff' }], ['glow', { color: '#36f1ff', size: em(0.35), strength: 180 }]],
        keys: sweepAt(26, 0.2, 1.6) }] },
    { id: 'wave-pass', name: 'Wave Pass', cat: 'emphasis', sides: 'once', anchor: 'start', sample: 'Riding the wave',
      description: 'A wave lifts the letters as it rolls through',
      animators: [{ name: 'Wave', range: { end: 30, shape: 'smooth' },
        effects: [['position', { x: 0, y: em(-0.55) }]],
        keys: sweepAt(30, 0.2, 1.5) }] },
    { id: 'pop-through', name: 'Pop Through', cat: 'emphasis', sides: 'once', anchor: 'start', sample: 'Each word gets its moment',
      description: 'Each word swells in turn as a pulse moves through',
      animators: [{ name: 'Pop', range: { basedOn: 'words', end: 40, shape: 'triangle' },
        effects: [['scale', { scale: 135 }]],
        keys: sweepAt(40, 0.2, 1.8) }] },
    { id: 'shine', name: 'Shine', cat: 'emphasis', sides: 'once', anchor: 'start', sample: 'A glint of light',
      description: 'A narrow glint of light runs over the letters',
      animators: [{ name: 'Shine', range: { end: 12, shape: 'smooth' },
        effects: [['fill', { color: '#fffbe6' }], ['glow', { color: '#fff1b8', size: em(0.2), strength: 140 }], ['scale', { scale: 108 }]],
        keys: sweepAt(12, 0.3, 1.1) }] },
    { id: 'marker', name: 'Marker', cat: 'emphasis', sides: 'once', anchor: 'start', sample: 'Highlight the whole line',
      description: 'A highlighter bar sweeps behind the text',
      animators: [{ name: 'Marker', range: { start: 0, end: 0 },
        effects: [['box', { color: ACCENT, padX: em(0.12), padY: em(0.06), radius: em(0.14) }], ['fill', { color: '#07130e' }]],
        keys: { end: [[0.2, 0, 'Smooth'], [1.2, 100]] } }] },
    { id: 'outline-pass', name: 'Outline Pass', cat: 'emphasis', sides: 'once', anchor: 'start', sample: 'HOLLOW PASS',
      description: 'Letters turn into outlines as a band passes over them',
      animators: [{ name: 'Outline', range: { end: 35, shape: 'smooth' },
        effects: [['stroke', { color: '#ffffff', width: em(0.03), outline: true }]],
        keys: sweepAt(35, 0.2, 1.6) }] },

    // ── Loop ──
    { id: 'neon-flow', name: 'Neon Flow', cat: 'loop', sides: 'loop', anchor: 'none', sample: 'NEON GLOW', labLayer: { color: '#56646f', stage: '#07090b' },
      description: 'A glowing band loops across the text without end',
      animators: [{ name: 'Neon', range: { end: 26, shape: 'triangle', flow: 36, loop: true },
        effects: [['fill', { color: '#f2ffff' }], ['glow', { color: '#36f1ff', size: em(0.35), strength: 180 }]] }] },
    { id: 'rainbow', name: 'Rainbow', cat: 'loop', sides: 'loop', anchor: 'none', sample: 'Rainbow flows through',
      description: 'A rainbow of colour flows through the letters',
      animators: [{ name: 'Rainbow', range: { shape: 'rampUp', flow: 25, loop: true },
        effects: [['fill', { color: '#ff5470' }], ['hue', { hue: 360, saturation: 0, brightness: 0 }]] }] },
    { id: 'gradient-flow', name: 'Gradient Flow', cat: 'loop', sides: 'loop', anchor: 'clip', sample: 'Gradient in motion',
      description: 'A colour gradient slides through the text for the whole layer',
      animators: [{ name: 'Gradient', range: {},
        effects: [['gradient', { colors: ['#7cf5ff', '#b36bff', '#ff5fa2'], angle: 0, span: 'text', repeat: true }]],
        keys: { '0.shift': [[0, 0, 'Linear'], [100, 200]] } }] },
    { id: 'jitter', name: 'Jitter', cat: 'loop', sides: 'loop', anchor: 'none', sample: 'Nervous energy!',
      description: 'Letters shake and twitch on their own',
      animators: [{ name: 'Jitter', range: {}, wiggle: { rate: 7, corr: 10 },
        effects: [['position', { x: em(0.12), y: em(0.15) }], ['rotation', { angle: 10 }]] }] },
    { id: 'float', name: 'Float', cat: 'loop', sides: 'loop', anchor: 'none', sample: 'Floating gently',
      description: 'Letters bob slowly, as if floating on water',
      animators: [{ name: 'Float', range: {}, wiggle: { rate: 0.8, corr: 35 },
        effects: [['position', { x: 0, y: em(0.18) }], ['rotation', { angle: 4 }]] }] },
    { id: 'flicker', name: 'Flicker', cat: 'loop', sides: 'loop', anchor: 'none', sample: 'BROKEN SIGN',
      description: 'Letters flicker on and off like a failing sign',
      animators: [{ name: 'Flicker', range: {}, wiggle: { rate: 9, corr: 0, min: 0, max: 100 },
        effects: [['opacity', { opacity: 15 }]] }] },
    { id: 'breathe', name: 'Breathing Wave', cat: 'loop', sides: 'loop', anchor: 'none', sample: 'Breathe in, breathe out',
      description: 'A gentle swell rolls across the text again and again',
      animators: [{ name: 'Breathe', range: { end: 40, shape: 'smooth', flow: 30, loop: true },
        effects: [['scale', { scale: 120 }], ['position', { x: 0, y: em(-0.1) }]] }] },
    { id: 'shimmer', name: 'Shimmer', cat: 'loop', sides: 'loop', anchor: 'none', sample: 'Golden shimmer',
      description: 'A warm glint keeps running over the letters',
      animators: [{ name: 'Shimmer', range: { end: 12, shape: 'smooth', flow: 60, loop: true },
        effects: [['fill', { color: '#fff1b0' }], ['glow', { color: '#ffd76a', size: em(0.16), strength: 120 }]] }] },

    // ── Characters ──
    { id: 'decode', name: 'Decode', cat: 'chars', sides: 'in', anchor: 'start', sample: 'DECRYPTING SIGNAL',
      description: 'Random glyphs resolve into the text, left to right',
      animators: [{ name: 'Decode', range: { smooth: 0 },
        effects: [['scramble', { charset: 'alnum', rate: 22 }], ['fill', { color: ACCENT }]],
        keys: { start: [[0, 0, 'Linear'], [1.6, 100]] } }] },
    { id: 'binary', name: 'Binary Decode', cat: 'chars', sides: 'in', anchor: 'start', sample: 'SYSTEM ONLINE',
      description: 'Zeros and ones resolve into the text',
      animators: [{ name: 'Binary', range: { smooth: 0 },
        effects: [['scramble', { charset: 'binary', rate: 18 }], ['fill', { color: ACCENT }]],
        keys: { start: [[0, 0, 'Linear'], [1.6, 100]] } }] },
    { id: 'alphabet-roll', name: 'Alphabet Roll', cat: 'chars', sides: 'in', anchor: 'start', sample: 'ROLLING LETTERS',
      description: 'Letters roll through the alphabet and stop on the text',
      animators: [{ name: 'Roll', range: {},
        effects: [['charOffset', { offset: 12 }]],
        keys: { amount: [[0, 100, 'Ease Out'], [1.4, 0]] } }] },
    { id: 'glitch', name: 'Glitch', cat: 'chars', sides: 'loop', anchor: 'none', sample: 'GLITCH MODE',
      description: 'Random letters keep breaking into glyphs and jumping',
      animators: [{ name: 'Glitch', range: { end: 25, randomize: true, seed: 5, flow: 40, loop: true, smooth: 0 },
        effects: [['scramble', { charset: 'symbols', rate: 14 }], ['position', { x: em(0.08), y: 0 }], ['fill', { color: '#ff3b6b', mix: 70 }]] }] },
    // ── Voice ──
    { id: 'voice-box', name: 'Spoken Box', cat: 'voice', sides: 'loop', anchor: 'drive', sample: VOICE_SAMPLE,
      description: 'A box sits under each word while it is spoken, dark text on top',
      animators: [{ name: 'Spoken box', range: voice({ animate: 'active', duration: 0.08, curve: 'Power2 Out', fadeOut: 0.08 }),
        effects: [['box', { color: ACCENT, padX: em(0.12), padY: em(0.04), radius: em(0.14), grow: false }], ['fill', { color: '#0b0d0c' }]] }] },
    { id: 'voice-pop', name: 'Spoken Pop', cat: 'voice', sides: 'loop', anchor: 'drive', sample: VOICE_SAMPLE,
      description: 'The spoken word swells and turns gold, then settles back',
      animators: [{ name: 'Spoken', range: voice({ animate: 'active', duration: 0.18, curve: 'Back Out', fadeOut: 0.2 }),
        effects: [['scale', { scale: 118 }], ['fill', { color: '#ffd23f' }]] }] },
    { id: 'voice-glow', name: 'Spoken Glow', cat: 'voice', sides: 'loop', anchor: 'drive', sample: VOICE_SAMPLE,
      description: 'The spoken word lights up with a cool glow',
      animators: [{ name: 'Glow', range: voice({ animate: 'active', duration: 0.1, curve: 'Linear', fadeOut: 0.25 }),
        effects: [['fill', { color: '#eafcff' }], ['glow', { color: '#36f1ff', size: em(0.3), strength: 160 }]] }] },
    { id: 'voice-sung', name: 'Sung Words', cat: 'voice', sides: 'in', anchor: 'drive', sample: VOICE_SAMPLE,
      description: 'Each word turns gold as it is sung and stays gold',
      animators: [{ name: 'Sung', range: voice({ animate: 'stay', duration: 0.15, curve: 'Linear' }),
        effects: [['fill', { color: '#ffd23f' }]] }] },
    { id: 'voice-wipe', name: 'Karaoke Wipe', cat: 'voice', sides: 'in', anchor: 'drive', sample: VOICE_SAMPLE,
      description: 'Colour wipes through each word letter by letter as it is sung',
      animators: [{ name: 'Wipe', range: voice({ basedOn: 'charsNoSpace', animate: 'stay', duration: 0.06, curve: 'Linear', spread: true }),
        effects: [['fill', { color: ACCENT }]] }] },
    { id: 'voice-read-along', name: 'Read Along', cat: 'voice', sides: 'in', anchor: 'drive', sample: VOICE_SAMPLE,
      description: 'Words wait dimmed and light up as they are said',
      animators: [{ name: 'Not spoken yet', range: voice({ animate: 'in', duration: 0.2, curve: 'Power2 Out' }),
        effects: [['opacity', { opacity: 30 }]] }] },
    { id: 'voice-word-pop', name: 'Word Pop', cat: 'voice', sides: 'in', anchor: 'drive', sample: VOICE_SAMPLE,
      description: 'Each word pops in the moment it is spoken',
      animators: [{ name: 'Pop in', range: voice({ animate: 'in', duration: 0.35, curve: 'Back Out' }),
        effects: [['scale', { scale: 40 }], ['opacity', { opacity: 0 }]] }] },
    { id: 'voice-rise', name: 'Rise on Voice', cat: 'voice', sides: 'in', anchor: 'drive', sample: VOICE_SAMPLE,
      description: 'Words rise softly out of a blur as they are spoken',
      animators: [{ name: 'Rise', range: voice({ animate: 'in', duration: 0.45, curve: 'Power3 Out' }),
        effects: [['position', { x: 0, y: em(0.45) }], ['blur', { amount: em(0.08) }], ['opacity', { opacity: 0 }]] }] },
    { id: 'voice-bounce', name: 'Bounce on Voice', cat: 'voice', sides: 'in', anchor: 'drive', sample: VOICE_SAMPLE,
      description: 'Words drop in and bounce as they are spoken',
      animators: [{ name: 'Drop', range: voice({ animate: 'in', duration: 0.6, curve: 'Bounce Out' }),
        effects: [['position', { x: 0, y: em(-0.7) }], ['opacity', { opacity: 0 }]] }] },
    { id: 'voice-typed', name: 'Typed as Spoken', cat: 'voice', sides: 'in', anchor: 'drive', sample: VOICE_SAMPLE,
      description: 'Letters type in at speaking pace behind a caret',
      animators: [{ name: 'Type', range: voice({ basedOn: 'charsNoSpace', animate: 'in', duration: 0.04, curve: 'Linear', spread: true }),
        effects: [['opacity', { opacity: 0 }], ['caret', {}]] }] },
  ];
  // Character presets count letters only (Characters, no spaces): a space takes
  // no turn, so typing and sweeps never pause on a gap. Words / Lines keep theirs.
  for (const p of PRESETS) for (const a of p.animators) a.range = { basedOn: 'charsNoSpace', ...a.range };

  // Seconds the timed part of a preset spans (0 for loops and clip-spread keys; an
  // animator spread over the clip takes no part in it).
  const anchorOf = (p, a) => (a && a.anchor) || p.anchor;
  function presetSpan(p) {
    if (p.anchor !== 'start' && p.anchor !== 'end') return 0;
    let span = 0;
    for (const a of p.animators) {
      if (anchorOf(p, a) !== p.anchor) continue;
      for (const keys of Object.values(a.keys || {})) for (const k of keys) span = Math.max(span, Math.abs(k[0]));
    }
    return span;
  }
  const isTimed = (p) => p.anchor === 'start' || p.anchor === 'end';
  // Sizes: a number = px; { em } = × the layer's font size; { px, em } = their sum;
  // minEm = at least that many font sizes, keeping the sign (of the value, or of
  // minEm when the value is 0) — a masked unit has to clear its own line, as Text
  // Animation's mask makes it.
  const resolveEm = (v, fontPx) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
    let n = (Number(v.px) || 0) + (Number(v.em) || 0) * fontPx;
    if (v.minEm) {
      const sign = n < 0 ? -1 : n > 0 ? 1 : Math.sign(v.minEm);
      n = sign * Math.max(Math.abs(n), Math.abs(v.minEm) * fontPx);
    }
    return Math.round(n * 100) / 100;
  };

  // A preset → { animators, tracks, layer } for one text layer.
  //   clipSec  the layer's length in seconds (key times are converted to % of it)
  //   fontPx   the layer's font size in composition px (em sizes resolve against it)
  //   duration seconds the timed part should take (default: the preset's own span);
  //            it never outlasts the layer
  //   speed    multiplier for keyframe-free motion (Flow, Wiggles / s, Changes / s)
  //   used     a Set of ids already on the layer (new ids avoid them)
  function build(p, { clipSec = 4, fontPx = 100, duration = null, speed = 1, used = null } = {}) {
    const ids = used instanceof Set ? used : new Set();
    const uid = (prefix) => { let n = 1; while (ids.has(`${prefix}${n}`)) n += 1; ids.add(`${prefix}${n}`); return `${prefix}${n}`; };
    const span = presetSpan(p);
    const clip = Math.max(0.1, clipSec);
    let scale = span > 0 && duration > 0 ? duration / span : 1;
    if (span > 0 && span * scale > clip) scale = clip / span;
    const pos = (t, anchor) => {
      let v;
      if (anchor === 'clip') v = t;
      else if (anchor === 'end') v = 100 + ((t * scale) / clip) * 100;
      else v = ((t * scale) / clip) * 100;
      return Math.round(Math.min(100, Math.max(0, v)) * 100) / 100;
    };
    const animators = [];
    const tracks = {};
    for (const a of p.animators) {
      const an = T.newAnimator(uid('a'), a.name);
      Object.assign(an.range, a.range || {});
      if (an.range.flow) an.range.flow *= speed;
      // Time / Voice timings are seconds: Speed shortens them the same way.
      if (an.range.drive === 'time' || an.range.drive === 'voice') {
        for (const k of ['delay', 'stagger', 'duration', 'hold', 'fadeOut']) an.range[k] /= speed;
      }
      if (a.wiggle) { Object.assign(an.wiggle, { enabled: true }, a.wiggle); an.wiggle.rate *= speed; }
      const pids = [];
      for (const [type, fields] of a.effects) {
        const fx = T.newEffect(uid('p'), type);
        for (const [k, v] of Object.entries(fields || {})) fx[k] = resolveEm(v, fontPx);
        if (type === 'scramble') fx.rate *= speed;
        an.effects.push(fx);
        pids.push(fx.pid);
      }
      for (const [chan, keys] of Object.entries(a.keys || {})) {
        const real = chan.replace(/^(\d+)\./, (m, i) => `${pids[Number(i)]}.`);
        const seen = new Set();
        const track = [];
        for (const [t, v, easing] of keys) {
          let at = pos(t, anchorOf(p, a));
          while (seen.has(at)) at = Math.round((at + 0.01) * 100) / 100;
          seen.add(at);
          track.push({ position: at, value: String(resolveEm(v, fontPx)), easing: easing || 'Smooth' });
        }
        tracks[T.trackKey(an.aid, real)] = track;
      }
      animators.push(an);
    }
    return {
      animators: T.sanitizeAnimators(animators),
      tracks,
      layer: { ...T.defaultsOf(T.LAYER_FIELDS), ...(p.layer || {}) },
    };
  }

  // A made-up voice for the lab and the preset tiles (no audio): one spoken window
  // { s, e, w } per word of `text`, from `start` s; 0.12 s + 0.055 s a letter, a short
  // gap, a breath after punctuation. Rate speeds it up.
  function fakeVoice(text, { start = 0.35, rate = 1 } = {}) {
    const wins = [];
    let t = start;
    for (const w of String(text || '').match(/\S+/g) || []) {
      const d = (0.12 + 0.055 * w.length) / rate;
      wins.push({ s: Math.round(t * 1000) / 1000, e: Math.round((t + d) * 1000) / 1000, w });
      t += d + (/[.,!?;:]$/.test(w) ? 0.3 : 0.06) / rate;
    }
    return wins;
  }
  const usesVoice = (p) => !!(p && Array.isArray(p.animators) && p.animators.some((a) => a.range && a.range.drive === 'voice'));
  const hasExit = (p) => !!(p && Array.isArray(p.animators) && p.animators.some((a) => a.range && (a.range.animate === 'out' || a.range.animate === 'inOut')));
  // The preset with a plain exit added (Presets ▸ Exit): its units fade out at the
  // layer's end, on the unit its first animator works on. Seconds from the end, so
  // trimming the layer never stretches it.
  function withExit(p) {
    if (!p || p.sides === 'out' || p.sides === 'loop' || hasExit(p)) return p;
    const first = p.animators[0] && p.animators[0].range;
    const basedOn = (first && first.basedOn) || 'chars';
    const stagger = basedOn === 'words' ? 0.04 : basedOn === 'lines' ? 0.08 : 0.015;
    return {
      ...p,
      sides: 'inOut',
      animators: [...p.animators, {
        name: 'Out',
        range: { drive: 'time', animate: 'out', basedOn, stagger, duration: 0.3, curve: 'Power2 In' },
        effects: [['opacity', { opacity: 0 }]],
      }],
    };
  }

  const api = { CATEGORIES, PRESETS, anchorOf, presetSpan, isTimed, resolveEm, build, fakeVoice, usesVoice, hasExit, withExit };
  return api;
};

const PRESETS_API = factory(TXA);
export const {
  CATEGORIES,
  PRESETS,
  anchorOf,
  presetSpan,
  isTimed,
  resolveEm,
  build,
  fakeVoice,
  usesVoice,
  hasExit,
  withExit,
} = PRESETS_API;
export default PRESETS_API;
