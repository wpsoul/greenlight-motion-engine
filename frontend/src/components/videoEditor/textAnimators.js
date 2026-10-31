// GENERATED from html/finished/text-animators-lab/engine.js by tests/text-animators/port_from_lab.mjs.
// Do not edit here: change the lab engine, then run  node tests/text-animators/port_from_lab.mjs
/*
 * Text Animators — engine (LEAF: no DOM, no imports; node-testable).
 *
 * Look-dev truth for PLANS/TEXT_ANIMATORS_PLAN.md. The app module
 * frontend/src/components/videoEditor/textAnimators.js is GENERATED from this file
 * by tests/text-animators/port_from_lab.mjs — edit here, then re-run the port. The
 * lab loads it as a classic script (window.TXA) so the page also works from file://.
 *
 * The After Effects model, decoded:
 *   An ANIMATOR holds EFFECTS (AE: properties) and a SELECTOR. The selector hands
 *   every unit (character / word / line) an amount in −1…1; each effect's value
 *   is what the unit gets at 100 % selection, and the amount scales it:
 *     additive       position, rotation, rotate 3D, skew, tracking, blur, stroke width
 *     multiplicative scale (1 → value), opacity (1 → value)
 *     paint          fill / gradient / hue fold into ONE paint, top to bottom
 *   Animators apply in list order. Each animator's transforms turn around ITS
 *   unit (Transform around, default = its Based on: a word range turns words —
 *   AE would still turn letters), nudged by the layer's Pivot X / Y. Animators on
 *   the same unit SUM (AE: order-independent); units nest letter ⊂ word ⊂ line ⊂
 *   all and compose finest first, so letters can bounce inside a word that flips.
 *   Rotate 3D projects in perspective (a camera Perspective px in front of the
 *   unit's centre); Canvas 2D can't, so warpBegin / warpEnd draw such a unit.
 *
 * Data (item level):
 *   textAnimatorPivotX, textAnimatorPivotY   (LAYER_FIELDS; a saved
 *   textAnimatorGrouping is from before Transform around moved to the animator,
 *   and is ignored)
 *   textAnimators: [ animator ]          — present only while it holds one
 * One animator:
 *   { aid, name, enabled,
 *     range:  { basedOn, around, units, start, end, offset, shape, smooth, easeHigh,
 *               easeLow, amount, randomize, seed, flow, loop },
 *     wiggle: { enabled, mode, max, min, rate, corr, tPhase, sPhase, seed },
 *     effects:[ { pid, type, enabled, ...fields } ] }
 *
 * Keyframe tracks (app: item.propertyKeyframes) — `txa:<aid>:<chan>`:
 *   range chans  start end offset amount smooth easeHigh easeLow
 *   wiggle chans wig.max wig.min wig.corr
 *   effect chans <pid>.<field>        e.g. txa:a1:p2.y
 * Rates (Flow, Wiggles / s, Changes / s) and seeds are not keyframable: a keyed
 * rate would jump the phase.
 */
const TXA = (function () {
  'use strict';

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, t) => a + (b - a) * t;

  // ── Schema (one source for sanitizer, panels, keyframe rows and labels) ────
  const num = (label, def, min, max, step, unit = '', kf = true, title = '') => ({ type: 'num', label, default: def, min, max, step, unit, kf, title });
  const en = (label, def, labels, title = '') => ({ type: 'enum', label, default: def, values: Object.keys(labels), labels, title });
  const bool = (label, def, title = '') => ({ type: 'bool', label, default: def, title });
  const col = (label, def) => ({ type: 'color', label, default: def });
  const cols = (label, def) => ({ type: 'colors', label, default: def });
  // A cubic bezier [x1, y1, x2, y2] — the keyframe graph's Custom curve — or null.
  const bez = (label, title = '') => ({ type: 'bezier', label, default: null, title });

  // The app's easing names (TransitionEasing values), each played by the same maths
  // GSAP uses in the app (see CURVE_FNS) — so a Time / Voice animator in the lab, a
  // preset tile and the Player all land on the same frame.
  const CURVE_NAMES = ['Linear', 'Ease In', 'Ease Out', 'Smooth', 'Smooth Glide', 'Glide Easing Stop', 'Power1 In', 'Power1 Out', 'Power1 Smooth',
    'Power2 In', 'Power2 Out', 'Power2 Smooth', 'Power3 In', 'Power3 Out', 'Power3 Smooth', 'Power4 In', 'Power4 Out',
    'Power4 Smooth', 'Sine In', 'Sine Out', 'Sine Smooth', 'Cubic In', 'Cubic Out', 'Cubic Smooth', 'Expo In', 'Expo Out',
    'Expo Smooth', 'Circ In', 'Circ Out', 'Circ Smooth', 'Back In', 'Back Out', 'Back Smooth', 'Bounce Out', 'Elastic',
    'Overshoot', 'Smooth Overshoot', 'Impulse', 'Swing', 'Anticipate', 'Natural', 'Slow Down', 'AE In', 'AE Smooth', 'AE Out'];

  const RANGE_FIELDS = {
    // What moves the selection. Range: Start / End / Offset (keyframes, Flow). Time
    // and Voice give every unit its own clock instead (see driveAmounts).
    drive: en('Drive', 'range', { range: 'Range', time: 'Time', voice: 'Voice' },
      'Range = Start / End / Offset. Time = each unit takes its turn, in seconds. Voice = each unit takes its turn when it is spoken (captions)'),
    animate: en('Animate', 'in', { in: 'In', out: 'Out', inOut: 'In & out', active: 'While its turn', stay: 'From its turn on' },
      'In: units arrive from the effects. Out: they leave into them at the layer end. While its turn: the effects light each unit in turn. From its turn on: they stay on'),
    order: en('Order', 'forward', { forward: 'Forward', backward: 'Backward', center: 'From centre', edges: 'From edges', random: 'Random' }),
    delay: num('Delay', 0, -60, 600, 0.01, 's', false, 'In: after the layer starts. Out: before the layer ends. Voice: after the word is spoken (negative = before)'),
    stagger: num('Stagger', 0.06, 0, 10, 0.005, 's', false, 'Time between one unit\'s turn and the next'),
    duration: num('Duration', 0.6, 0, 20, 0.01, 's', false, 'How long each unit takes'),
    // Custom plays `bezier` (the app's keyframe Custom: a curve shaped by its handles).
    curve: en('Curve', 'Ease Out', { ...Object.fromEntries(CURVE_NAMES.map((n) => [n, n])), Custom: 'Custom' },
      'Each unit\'s own easing: Back, Bounce and Overshoot land past their rest and settle'),
    bezier: bez('Custom curve', 'The Custom curve\'s handles, x1 y1 x2 y2 (x 0…1, y −3…4)'),
    hold: num('Hold', 0, 0, 600, 0.01, 's', false, 'How long a unit stays lit. 0 = until the next unit\'s turn'),
    fadeOut: num('Fade out', 0, 0, 20, 0.01, 's', false),
    keepLast: bool('Keep last on', false, 'The last unit stays lit'),
    spread: bool('Letters follow the voice', true, 'Letters of a word take their turns across the time it is spoken, so they type at speaking pace'),
    basedOn: en('Based on', 'chars', { chars: 'Characters', charsNoSpace: 'Characters, no spaces', words: 'Words', lines: 'Lines' }),
    // What Position, Scale, Rotation, Rotate 3D and Skew turn around (see levelOf).
    around: en('Transform around', 'auto', { auto: 'Same as Based on', char: 'Each character', word: 'Each word', line: 'Each line', all: 'Whole text' },
      'The unit this animator moves, scales and turns. Same as Based on: a word range turns whole words'),
    units: en('Units', 'percent', { percent: '%', index: 'Index' }, 'Index = count units (Start 2 = the third unit)'),
    start: num('Start', 0, -1000, 1000, 1),
    end: num('End', 100, -1000, 1000, 1),
    offset: num('Offset', 0, -1000, 1000, 1),
    shape: en('Shape', 'square', { square: 'Square', rampUp: 'Ramp up', rampDown: 'Ramp down', triangle: 'Triangle', round: 'Round', smooth: 'Smooth' }),
    smooth: num('Smoothness', 100, 0, 100, 1, '%', true, 'Width of the edge fade, in units: 100 % = one unit'),
    easeHigh: num('Ease high', 0, -100, 100, 1, '%'),
    easeLow: num('Ease low', 0, -100, 100, 1, '%'),
    amount: num('Amount', 100, -100, 100, 1, '%', true, 'Negative amounts push every effect the other way'),
    randomize: bool('Random order', false),
    seed: num('Seed', 1, 0, 9999, 1, '', false),
    // Keyframe-free travel: Offset advances this much per second (the Stroke
    // options "Flow" idea). Integrated by time, so not keyframable. Without Loop a
    // range parked off the text lands at Offset 0 and stays (see rangeEdges).
    flow: num('Flow', 0, -400, 400, 1, '/s', false, 'Moves the whole range (its Offset) this much per second, no keyframes. From a negative Offset the range travels in and stops in place; from 0 it travels off the text'),
    loop: bool('Loop', false, 'The range wraps around the ends'),
    // Units are cut off at the edge of their own resting box (Transform around's
    // unit), so a move slides them in from behind it — Text Animation's Mask.
    mask: bool('Mask', false, 'Each unit is cut off at the edge of its own box, so it slides in from behind it'),
  };
  // Range fields that only mean something under one drive (panel + keyframe rows).
  const RANGE_ONLY = { units: 1, start: 1, end: 1, offset: 1, shape: 1, smooth: 1, easeHigh: 1, easeLow: 1, flow: 1 };
  const DRIVE_ONLY = { animate: 1, order: 1, delay: 1, stagger: 1, duration: 1, curve: 1, bezier: 1, hold: 1, fadeOut: 1, keepLast: 1, spread: 1 };
  // Which Range fields a panel shows for an animator (lab and app alike). voiced = a
  // Voice animator whose timings fit the text: Order and Stagger only matter when
  // they don't (it then runs as Time).
  function rangeShows(an, key, { voiced = false } = {}) {
    const r = (an && an.range) || {};
    const driven = r.drive === 'time' || r.drive === 'voice';
    if (key === 'drive' || key === 'basedOn' || key === 'amount') return true;
    if (key === 'around' || key === 'mask') return hasTransform(an);
    if (RANGE_ONLY[key]) {
      if (driven) return false;
      if (key === 'smooth') return r.shape === 'square';
      if (key === 'easeHigh' || key === 'easeLow') return r.shape !== 'square';
      return true;
    }
    if (key === 'randomize') return !driven;
    if (key === 'seed') return driven ? r.order === 'random' && !(r.drive === 'voice' && voiced) : !!r.randomize;
    if (key === 'loop') return !driven || (r.drive === 'time' && r.animate !== 'out' && r.animate !== 'inOut');
    if (!driven) return false;
    if (key === 'order' || key === 'stagger') return !(r.drive === 'voice' && voiced) || r.animate === 'out' || r.animate === 'inOut';
    if (key === 'hold' || key === 'keepLast') return r.animate === 'active';
    if (key === 'fadeOut') return r.animate === 'active';
    if (key === 'spread') return r.drive === 'voice' && (r.basedOn === 'chars' || r.basedOn === 'charsNoSpace');
    return !!DRIVE_ONLY[key];
  }
  // Effect fields that only show with another one on.
  const FIELD_WHEN = { caret: { color: (v) => !!v.ownColor, hideAfter: (v) => !!v.hide }, box: { withText: (v) => v.shape === 'unit' } };
  const fieldShown = (type, key, values) => !(FIELD_WHEN[type] && FIELD_WHEN[type][key]) || FIELD_WHEN[type][key](values || {});

  const WIGGLE_FIELDS = {
    enabled: bool('Wiggle', false),
    mode: en('Mode', 'intersect', { add: 'Add', subtract: 'Subtract', intersect: 'Intersect', min: 'Min', max: 'Max', difference: 'Difference' }),
    max: num('Max amount', 100, -100, 100, 1, '%'),
    min: num('Min amount', -100, -100, 100, 1, '%'),
    rate: num('Wiggles / s', 2, 0, 30, 0.1, '/s', false),
    corr: num('Correlation', 0, 0, 100, 1, '%'),
    tPhase: num('Temporal phase', 0, -360, 360, 1, '°', false),
    sPhase: num('Spatial phase', 0, -360, 360, 1, '°', false),
    seed: num('Seed', 1, 0, 9999, 1, '', false),
  };

  // Layer-level (item fields beside `textAnimators`): where in its unit every
  // transform turns. Pivot X / Y = % of the unit's box from its centre (100 =
  // right / bottom edge) — AE's Grouping Alignment. The unit itself is each
  // animator's own (range.around).
  const LAYER_FIELDS = {
    pivotX: num('Pivot X', 0, -100, 100, 1, '%', false, '% of the unit from its centre: −100 = left edge, 100 = right edge'),
    pivotY: num('Pivot Y', 0, -100, 100, 1, '%', false, '% of the unit from its centre: −100 = top, 100 = bottom'),
  };
  const LAYER_ITEM_KEYS = { pivotX: 'textAnimatorPivotX', pivotY: 'textAnimatorPivotY' };

  const EFFECTS = [
    { key: 'position', label: 'Position', group: 'Transform', desc: 'Move the selected units',
      fields: { x: num('X', 0, -2000, 2000, 1, 'px'), y: num('Y', -80, -2000, 2000, 1, 'px') } },
    { key: 'scale', label: 'Scale', group: 'Transform', desc: 'Grow or shrink each unit',
      fields: { scale: num('Scale', 160, -1000, 1000, 1, '%'), x: num('Width', 100, -1000, 1000, 1, '%'), y: num('Height', 100, -1000, 1000, 1, '%') } },
    { key: 'rotation', label: 'Rotation', group: 'Transform', desc: 'Spin each unit around its pivot',
      fields: { angle: num('Angle', 45, -3600, 3600, 1, '°') } },
    { key: 'rotate3d', label: 'Rotate 3D', group: 'Transform', desc: 'Flip around X or Y, in perspective',
      fields: { x: num('Rotate X', 90, -720, 720, 1, '°', true, 'Positive tips the top away from you'), y: num('Rotate Y', 0, -720, 720, 1, '°', true, 'Positive turns the right side away from you'),
        perspective: num('Perspective', 800, 0, 20000, 10, 'px', true, 'Camera distance from the unit: smaller = deeper 3D. 0 = flat, no depth') } },
    { key: 'skew', label: 'Skew', group: 'Transform', desc: 'Slant along an axis',
      fields: { skew: num('Skew', 25, -85, 85, 1, '°'), axis: num('Axis', 0, -180, 180, 1, '°') } },
    { key: 'tracking', label: 'Tracking', group: 'Transform', desc: 'Space the units out — the line reflows',
      fields: { amount: num('Amount', 40, -200, 600, 1, 'px') } },
    { key: 'opacity', label: 'Opacity', group: 'Colour', desc: 'Fade the selected units',
      fields: { opacity: num('Opacity', 0, 0, 100, 1, '%') } },
    { key: 'fill', label: 'Fill colour', group: 'Colour', desc: 'Recolour the selection',
      fields: { color: col('Colour', '#ffd84d'), mix: num('Mix', 100, 0, 100, 1, '%') } },
    { key: 'gradient', label: 'Gradient', group: 'Colour', desc: 'Paint the selection with a gradient',
      fields: { colors: cols('Colours', ['#7cf5ff', '#b36bff', '#ff5fa2']), angle: num('Angle', 0, -360, 360, 1, '°'), span: en('Spans', 'text', { text: 'Text', unit: 'Unit' }), shift: num('Shift', 0, -1000, 1000, 1, '%'), repeat: bool('Repeat', false), mix: num('Mix', 100, 0, 100, 1, '%') } },
    { key: 'hue', label: 'Hue shift', group: 'Colour', desc: 'Rotate hue, saturation and brightness',
      fields: { hue: num('Hue', 180, -720, 720, 1, '°'), saturation: num('Saturation', 0, -100, 100, 1, '%'), brightness: num('Brightness', 0, -100, 100, 1, '%') } },
    { key: 'stroke', label: 'Stroke', group: 'Colour', desc: 'Outline around the glyphs',
      fields: { color: col('Colour', '#ffffff'), width: num('Width', 4, 0, 60, 0.5, 'px'), outline: bool('Outline only', false) } },
    { key: 'glow', label: 'Glow', group: 'Light', desc: 'Soft light around the glyphs',
      fields: { color: col('Colour', '#5ef2ff'), size: num('Size', 30, 0, 200, 1, 'px'), strength: num('Strength', 120, 0, 300, 1, '%') } },
    { key: 'shadow', label: 'Drop shadow', group: 'Light', desc: 'Offset shadow under the glyphs',
      fields: { color: col('Colour', '#000000'), x: num('X', 0, -400, 400, 1, 'px'), y: num('Y', 18, -400, 400, 1, 'px'), blur: num('Blur', 20, 0, 200, 1, 'px'), opacity: num('Opacity', 70, 0, 100, 1, '%') } },
    { key: 'blur', label: 'Blur', group: 'Light', desc: 'Defocus the selection',
      fields: { amount: num('Blur', 18, 0, 120, 0.5, 'px') } },
    { key: 'box', label: 'Highlight box', group: 'Decorate', desc: 'A bar behind each selected run',
      fields: {
        color: col('Colour', '#33efab'),
        behind: en('Behind', 'selected', { selected: 'Selected', revealed: 'Revealed' }, 'Revealed = the text this animator lets through. On a typing animator the box grows with the typing'),
        shape: en('Shape', 'line', { line: 'Per line', unit: 'Per unit', block: 'Block' }, 'Per line = one bar per run of selected units in a row. Per unit = a bar behind each unit on its own. Block = one shape around all of it, growing a line at a time'),
        padX: num('Padding X', 12, 0, 200, 1, 'px'), padY: num('Padding Y', 4, -60, 200, 1, 'px'), radius: num('Radius', 10, 0, 200, 1, 'px'), opacity: num('Opacity', 100, 0, 100, 1, '%'), grow: bool('Grow with range', true),
        withText: bool('Fade with text', false, 'Each bar is only as visible as its unit: a word that has not appeared yet has no bar'),
      } },
    // A text cursor at the edge of what this animator lets through (what an Opacity 0
    // on the same range leaves visible) — on an In animator it types with the text.
    { key: 'caret', label: 'Caret', group: 'Decorate', desc: 'A text cursor at the typing edge',
      fields: {
        style: en('Style', 'bar', { bar: 'Bar', underscore: 'Underscore', block: 'Block' }),
        ownColor: bool('Own colour', false, 'Off = the text colour'),
        color: col('Colour', '#ffffff'),
        width: num('Width', 0, 0, 80, 0.5, 'px', false, '0 = automatic'),
        blink: num('Blinks / s', 1.1, 0, 10, 0.1, '/s', false, 'While the text is not typing. 0 = solid'),
        hide: bool('Hide when typed', false),
        hideAfter: num('Hide after', 0, 0, 600, 0.1, 's', false, 'Seconds after the typing ends'),
      } },
    { key: 'scramble', label: 'Scramble', group: 'Characters', desc: 'Random glyphs that settle into the text',
      fields: { charset: en('Characters', 'upper', { upper: 'A–Z', lower: 'a–z', digits: '0–9', alnum: 'A–Z 0–9', symbols: 'Symbols', binary: 'Binary', blocks: 'Blocks' }), rate: num('Changes / s', 18, 0, 60, 1, '/s', false), seed: num('Seed', 1, 0, 9999, 1, '', false) } },
    { key: 'charOffset', label: 'Character offset', group: 'Characters', desc: 'Shift letters through the alphabet',
      fields: { offset: num('Offset', 6, -60, 60, 1, '') } },
  ];
  const EFFECT_BY_KEY = Object.fromEntries(EFFECTS.map((e) => [e.key, e]));
  const EFFECT_GROUPS = ['Transform', 'Colour', 'Light', 'Decorate', 'Characters'];

  const MAX_ANIMATORS = 8;
  const MAX_EFFECTS = 12;

  const CHARSETS = {
    upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    lower: 'abcdefghijklmnopqrstuvwxyz',
    digits: '0123456789',
    alnum: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
    symbols: '!@#$%&*+=?<>/\\|{}[]~^',
    binary: '01',
    blocks: '█▓▒░▚▞▙▟',
  };

  // ── Defaults / sanitize ───────────────────────────────────────────────────
  function defaultsOf(fields) {
    const out = {};
    for (const [k, f] of Object.entries(fields)) out[k] = Array.isArray(f.default) ? f.default.slice() : f.default;
    return out;
  }
  function sanitizeField(f, v) {
    switch (f.type) {
      case 'num': { const n = Number(v); return Number.isFinite(n) ? clamp(n, f.min, f.max) : f.default; }
      case 'enum': return f.values.includes(v) ? v : f.default;
      case 'bool': return typeof v === 'boolean' ? v : f.default;
      case 'color': return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : f.default;
      case 'colors': {
        const list = Array.isArray(v) ? v.filter((c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c)).slice(0, 6) : [];
        return list.length >= 2 ? list.map((c) => c.toLowerCase()) : f.default.slice();
      }
      // The app's sanitizeBezier (easingCurves.js): x stays in 0…1 so the solver
      // converges, y may overshoot; 4 dp so a dragged handle stays short.
      case 'bezier': {
        if (!Array.isArray(v) || v.length !== 4) return f.default;
        const n = v.map(Number);
        if (n.some((x) => !Number.isFinite(x))) return f.default;
        const r4 = (x) => Math.round(x * 1e4) / 1e4;
        return [r4(clamp(n[0], 0, 1)), r4(clamp(n[1], -3, 4)), r4(clamp(n[2], 0, 1)), r4(clamp(n[3], -3, 4))];
      }
      default: return f.default;
    }
  }
  function sanitizeGroup(fields, raw) {
    const out = {};
    const src = raw && typeof raw === 'object' ? raw : {};
    for (const [k, f] of Object.entries(fields)) out[k] = sanitizeField(f, src[k]);
    return out;
  }
  const ID_RE = /^[A-Za-z0-9_-]{1,24}$/;
  function sanitizeEffect(raw) {
    const def = raw && EFFECT_BY_KEY[raw.type];
    if (!def || !ID_RE.test(String(raw.pid || ''))) return null;
    return { pid: raw.pid, type: def.key, enabled: raw.enabled !== false, ...sanitizeGroup(def.fields, raw) };
  }
  function sanitizeAnimator(raw, i) {
    if (!raw || typeof raw !== 'object' || !ID_RE.test(String(raw.aid || ''))) return null;
    const seen = new Set();
    const effects = (Array.isArray(raw.effects) ? raw.effects : [])
      .map(sanitizeEffect)
      .filter((e) => e && !seen.has(e.pid) && seen.add(e.pid))
      .slice(0, MAX_EFFECTS);
    const range = sanitizeGroup(RANGE_FIELDS, raw.range);
    // The handles belong to Custom alone: a Custom without them plays the default
    // curve, and a named curve drops them (as a keyframe does when a name is picked).
    if (range.curve !== 'Custom') range.bezier = null;
    else if (!range.bezier) range.curve = RANGE_FIELDS.curve.default;
    return {
      aid: raw.aid,
      name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 40) : `Animator ${i + 1}`,
      enabled: raw.enabled !== false,
      range,
      wiggle: sanitizeGroup(WIGGLE_FIELDS, raw.wiggle),
      effects,
    };
  }
  function sanitizeAnimators(list) {
    if (!Array.isArray(list)) return [];
    const seen = new Set();
    return list
      .map(sanitizeAnimator)
      .filter((a) => a && !seen.has(a.aid) && seen.add(a.aid))
      .slice(0, MAX_ANIMATORS);
  }
  // Item fields for a timeline item: the list plus its three layer fields, or
  // nothing at all while the list is empty (older items round-trip unchanged).
  function sanitizeItemFields(item) {
    const list = sanitizeAnimators(item && item.textAnimators);
    if (!list.length) return {};
    const raw = {};
    for (const [k, key] of Object.entries(LAYER_ITEM_KEYS)) raw[k] = item[key];
    const lf = sanitizeGroup(LAYER_FIELDS, raw);
    const out = { textAnimators: list };
    for (const [k, key] of Object.entries(LAYER_ITEM_KEYS)) out[key] = lf[k];
    return out;
  }
  function layerSettings(item) {
    const raw = {};
    for (const [k, key] of Object.entries(LAYER_ITEM_KEYS)) raw[k] = item && item[key];
    return sanitizeGroup(LAYER_FIELDS, raw);
  }
  function newAnimator(aid, name) {
    return { aid, name, enabled: true, range: defaultsOf(RANGE_FIELDS), wiggle: defaultsOf(WIGGLE_FIELDS), effects: [] };
  }
  function newEffect(pid, type) {
    const def = EFFECT_BY_KEY[type];
    return { pid, type, enabled: true, ...defaultsOf(def.fields) };
  }

  // ── Liveness / grain / motion ─────────────────────────────────────────────
  // Animators that change something: enabled, with at least one enabled effect.
  function liveAnimators(list) {
    if (!Array.isArray(list) || !list.length) return null;
    const live = list.filter((an) => an && an.enabled !== false && Array.isArray(an.effects)
      && an.effects.some((e) => e && e.enabled !== false && EFFECT_BY_KEY[e.type]));
    return live.length ? live : null;
  }
  // The finest unit any live animator selects by or turns around:
  // 'symbols' | 'words' | 'lines'. Voice needs at least words: the spoken times are
  // one per word, and a line finds its words through the units' word index.
  function grainOf(list) {
    let g = 'lines';
    for (const an of list || []) {
      const b = an && an.range && an.range.basedOn;
      if (b === 'chars' || b === 'charsNoSpace') return 'symbols';
      if (b === 'words' || (an && an.range && an.range.drive === 'voice')) g = 'words';
      const lv = hasTransform(an) ? levelOf(an.range) : null;
      if (lv === 'char') return 'symbols';
      if (lv === 'word') g = 'words';
    }
    return g;
  }
  // Does the animator move its units (Position, Scale, Rotation, Rotate 3D, Skew)?
  function hasTransform(an) {
    return !!(an && Array.isArray(an.effects) && an.effects.some((e) => e && e.enabled !== false && XF_TYPES[e.type]));
  }
  // Does any effect reflow the row (Tracking)? Only then must the evaluation run
  // before the layout is final; otherwise it can wait for the paint.
  function needsLayout(list) {
    return (list || []).some((an) => an.effects.some((e) => e.enabled !== false && e.type === 'tracking'));
  }
  // Does the stack change between frames? `hasTrack(aid)` says whether that
  // animator has any keyframe track. A static stack paints once and is cached.
  function animatorsMove(animators, hasTrack) {
    for (const an of animators || []) {
      if (!an || an.enabled === false || !an.effects?.some((e) => e.enabled !== false)) continue;
      if (an.range?.drive && an.range.drive !== 'range') return true;
      if (an.effects.some((e) => e.enabled !== false && e.type === 'caret' && e.blink > 0)) return true;
      if (an.range?.flow) return true;
      if (an.wiggle?.enabled && an.wiggle.rate > 0) return true;
      if (an.effects.some((e) => e.enabled !== false && e.type === 'scramble' && e.rate > 0)) return true;
      if (hasTrack && hasTrack(an.aid)) return true;
    }
    return false;
  }

  // ── Keyframe tracks ───────────────────────────────────────────────────────
  const KF_PREFIX = 'txa:';
  const TRACK_RE = /^txa:([A-Za-z0-9_-]{1,24}):([A-Za-z0-9_.-]{1,60})$/;
  const trackKey = (aid, chan) => `${KF_PREFIX}${aid}:${chan}`;
  function parseTrackKey(key) {
    const m = typeof key === 'string' ? TRACK_RE.exec(key) : null;
    return m ? { aid: m[1], chan: m[2] } : null;
  }
  // What a channel animates on this list: { spec, label } — or null for an orphan
  // (animator / effect gone) or a channel that is not keyframable.
  function channelInfo(animators, aid, chan) {
    const an = (animators || []).find((a) => a && a.aid === aid);
    if (!an) return null;
    if (chan.startsWith('wig.')) {
      const f = WIGGLE_FIELDS[chan.slice(4)];
      return f && f.kf ? { an, spec: f, label: `Wiggle ${f.label.toLowerCase()}` } : null;
    }
    const dot = chan.indexOf('.');
    if (dot > 0) {
      const fx = (an.effects || []).find((e) => e && e.pid === chan.slice(0, dot));
      const def = fx && EFFECT_BY_KEY[fx.type];
      const f = def && def.fields[chan.slice(dot + 1)];
      if (!f || f.type !== 'num' || !f.kf) return null;
      const numeric = Object.values(def.fields).filter((x) => x.type === 'num' && x.kf).length;
      return { an, fx, spec: f, label: numeric === 1 || f.label === def.label ? def.label : `${def.label} ${f.label}` };
    }
    const f = RANGE_FIELDS[chan];
    if (!f || !f.kf) return null;
    const unit = (chan === 'start' || chan === 'end' || chan === 'offset') ? (an.range?.units === 'index' ? '' : '%') : f.unit;
    return { an, spec: { ...f, unit }, label: f.label };
  }
  function trackLabel(animators, key) {
    const p = parseTrackKey(key);
    const info = p && channelInfo(animators, p.aid, p.chan);
    return info ? `${info.an.name} · ${info.label}` : null;
  }
  // Keyframes-panel rows for an item (the buildLayerMaskKfProps pattern): one row
  // per keyframable channel that exists right now, so no row animates nothing.
  function buildKfProps(item) {
    const list = Array.isArray(item && item.textAnimators) ? item.textAnimators : [];
    const out = [];
    const row = (an, chan) => {
      const info = channelInfo(list, an.aid, chan);
      if (!info) return;
      out.push({
        label: trackKey(an.aid, chan),
        group: 'Animators',
        displayLabel: `${an.name} · ${info.label}`,
        placeholder: String(info.spec.default),
        unit: info.spec.unit,
        type: 'number',
        min: info.spec.min,
        max: info.spec.max,
        step: info.spec.step,
      });
    };
    for (const an of list) {
      if (!an || !an.aid) continue;
      const driven = !!an.range?.drive && an.range.drive !== 'range';
      for (const [k, f] of Object.entries(RANGE_FIELDS)) {
        if (!f.kf) continue;
        if (driven && RANGE_ONLY[k]) continue;
        if (k === 'smooth' && an.range?.shape !== 'square') continue;
        if ((k === 'easeHigh' || k === 'easeLow') && an.range?.shape === 'square') continue;
        row(an, k);
      }
      if (an.wiggle && an.wiggle.enabled) for (const [k, f] of Object.entries(WIGGLE_FIELDS)) if (f.kf) row(an, `wig.${k}`);
      for (const fx of an.effects || []) {
        const def = EFFECT_BY_KEY[fx.type];
        if (!def) continue;
        for (const [k, f] of Object.entries(def.fields)) if (f.type === 'num' && f.kf) row(an, `${fx.pid}.${k}`);
      }
    }
    return out;
  }

  // ── Keyframes (lab-side; the app uses evaluatePropertyTrack) ─────────────
  const EASE = {
    linear: (t) => t,
    easeInOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
    easeOut: (t) => 1 - Math.pow(1 - t, 3),
    easeIn: (t) => t * t * t,
    sineInOut: (t) => 0.5 - 0.5 * Math.cos(Math.PI * t),
    backOut: (t) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); },
  };
  // keys: [{ p: 0..100 (% of clip), v: number, e: easing }] sorted by p.
  function evalTrack(keys, pos) {
    if (!keys || !keys.length) return undefined;
    if (pos <= keys[0].p) return keys[0].v;
    const last = keys[keys.length - 1];
    if (pos >= last.p) return last.v;
    for (let i = 0; i < keys.length - 1; i += 1) {
      const a = keys[i], b = keys[i + 1];
      if (pos >= a.p && pos <= b.p) {
        const span = b.p - a.p;
        const t = span > 1e-9 ? (pos - a.p) / span : 1;
        return lerp(a.v, b.v, (EASE[a.e] || EASE.easeInOut)(t));
      }
    }
    return last.v;
  }

  // ── Hashes / noise (deterministic: export renders frames out of order) ────
  function hashU32(a, b) {
    let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul((b | 0) + 0x165667b1, 0x9e3779b1);
    h = Math.imul(h ^ (h >>> 15), 0x85ebca77);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae3d);
    return (h ^ (h >>> 16)) >>> 0;
  }
  const hash01 = (a, b) => hashU32(a, b) / 4294967295;
  function noise1(x, seed) {
    const i = Math.floor(x);
    const f = x - i;
    const a = hash01(i, seed) * 2 - 1;
    const b = hash01(i + 1, seed) * 2 - 1;
    const s = f * f * (3 - 2 * f);
    return a + (b - a) * s;
  }
  function mulberry32(seed) {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const permCache = new Map();
  function seededPerm(n, seed) {
    const key = `${n}:${seed}`;
    let p = permCache.get(key);
    if (p) return p;
    p = Array.from({ length: n }, (_, i) => i);
    const rnd = mulberry32(seed * 7919 + 13);
    for (let i = n - 1; i > 0; i -= 1) { const j = Math.floor(rnd() * (i + 1)); const t = p[i]; p[i] = p[j]; p[j] = t; }
    if (permCache.size > 64) permCache.clear();
    permCache.set(key, p);
    return p;
  }

  // ── Selector math ─────────────────────────────────────────────────────────
  // Ease Low / Ease High bend the shape near 0 / near 1: a Hermite curve whose end
  // slopes are 1 − ease (0 → linear; +100 → flat, lingering; −100 → slope 2, snappy).
  function easeShape(f, low, high) {
    if (!low && !high) return f;
    const m0 = 1 - low / 100;
    const m1 = 1 - high / 100;
    const f2 = f * f, f3 = f2 * f;
    return clamp((f3 - 2 * f2 + f) * m0 + (-2 * f3 + 3 * f2) + (f3 - f2) * m1, 0, 1);
  }
  // c = unit centre in selector space (unit i spans [i, i+1]); [S, E] = range.
  function shapeAt(c, S, E, r, zeroOutside) {
    if (r.shape === 'square') {
      // Smoothness = width of the edge ramp in units: 100 % = one unit, so the
      // edge unit is selected by exactly how much of it the range covers.
      const w = Math.max(1e-4, r.smooth / 100);
      return Math.min(clamp((c - S) / w + 0.5, 0, 1), clamp((E - c) / w + 0.5, 0, 1));
    }
    const width = E - S;
    if (width <= 1e-6) return 0;
    const u = (c - S) / width;
    if (u < 0) return !zeroOutside && r.shape === 'rampDown' ? 1 : 0;
    if (u > 1) return !zeroOutside && r.shape === 'rampUp' ? 1 : 0;
    let f;
    switch (r.shape) {
      case 'rampUp': f = u; break;
      case 'rampDown': f = 1 - u; break;
      case 'triangle': f = 1 - Math.abs(2 * u - 1); break;
      case 'round': { const q = 2 * u - 1; f = Math.sqrt(Math.max(0, 1 - q * q)); break; }
      default: f = 0.5 - 0.5 * Math.cos(2 * Math.PI * u); // smooth
    }
    return easeShape(f, r.easeLow, r.easeHigh);
  }
  function combine(a, b, mode) {
    switch (mode) {
      case 'add': return a + b;
      case 'subtract': return a - b;
      case 'min': return Math.min(a, b);
      case 'max': return Math.max(a, b);
      case 'difference': return Math.abs(a - b);
      default: return a * b; // intersect
    }
  }
  // Range edges in selector space, for the panel strip and the stage brackets.
  function rangeEdges(r, N, time) {
    let s = r.start, e = r.end;
    if (r.units === 'percent') { s = clamp(s, 0, 100); e = clamp(e, 0, 100); }
    if (s > e) { const t = s; s = e; e = t; }
    const flow = r.flow || 0;
    let off = r.offset + flow * time;
    if (r.loop) {
      const period = r.units === 'percent' ? 100 : Math.max(1, N);
      off = ((off % period) + period) % period;
    } else if (r.offset < 0 && flow > 0) {
      // Flow carries a range parked off the text IN and stops it in place (Offset 0):
      // an appearance. From 0, or heading away, it travels on off the text: an exit.
      off = Math.min(off, 0);
    } else if (r.offset > 0 && flow < 0) {
      off = Math.max(off, 0);
    }
    const k = r.units === 'percent' ? N / 100 : 1;
    return { S: (s + off) * k, E: (e + off) * k };
  }
  // One amount per selector index 0…N-1, in −1…1.
  function selection(r, w, N, time) {
    const out = new Float32Array(Math.max(0, N));
    if (N <= 0) return { amounts: out, S: 0, E: 0 };
    const { S, E } = rangeEdges(r, N, time);
    const perm = r.randomize ? seededPerm(N, r.seed) : null;
    const amt = r.amount / 100;
    for (let i = 0; i < N; i += 1) {
      const c = (perm ? perm[i] : i) + 0.5;
      let f = r.loop
        ? Math.max(shapeAt(c - N, S, E, r, true), shapeAt(c, S, E, r, true), shapeAt(c + N, S, E, r, true))
        : shapeAt(c, S, E, r, false);
      f *= amt;
      if (w) {
        const t = time * w.rate + w.tPhase / 360;
        const nu = noise1(t + i * (w.sPhase / 360), hashU32(w.seed, i + 1));
        const ng = noise1(t, hashU32(w.seed, 0));
        const v = lerp(nu, ng, w.corr / 100);
        const wv = (w.min + ((v + 1) / 2) * (w.max - w.min)) / 100;
        f = combine(f, wv, w.mode);
      }
      out[i] = clamp(f, -1, 1);
    }
    return { amounts: out, S, E };
  }

  // ── Curves (the app's easing names, played by GSAP's maths) ───────────────
  // The same formulas GSAP 3 runs for Text Animation in the app (applyGsapEasing),
  // the AE / MotionFast beziers (mtl.js bezierEase) and the sampled spring tables
  // (easingCurves.js); engine.test.mjs compares every name against the app.
  const powIn = (n) => (p) => Math.pow(p, n);
  const outOf = (fin) => (p) => 1 - fin(1 - p);
  const inOutOf = (fin) => (p) => (p < 0.5 ? fin(p * 2) / 2 : 1 - fin((1 - p) * 2) / 2);
  // GSAP 3.14's Expo: exactly 0 at the start and 1 at the end.
  const expoIn = (p) => Math.pow(2, 10 * (p - 1)) * p + Math.pow(p, 6) * (1 - p);
  const sineIn = (p) => (p === 1 ? 1 : 1 - Math.cos((p * Math.PI) / 2));
  const circIn = (p) => -(Math.sqrt(1 - p * p) - 1);
  const backIn = (p) => (p ? p * p * (2.70158 * p - 1.70158) : 0);
  function bounceOut(p) {
    const n1 = 7.5625, c = 2.75;
    if (p < 1 / c) return n1 * p * p;
    if (p < 2 / c) return n1 * Math.pow(p - 1.5 / c, 2) + 0.75;
    if (p < 2.5 / c) return n1 * Math.pow(p - 2.25 / c, 2) + 0.9375;
    return n1 * Math.pow(p - 2.625 / c, 2) + 0.984375;
  }
  const elasticOut = (p) => (p === 1 ? 1 : Math.pow(2, -10 * p) * Math.sin((p - 0.075) * ((2 * Math.PI) / 0.3)) + 1);
  function bezier(p1x, p1y, p2x, p2y) {
    const bx = (t) => 3 * p1x * t * (1 - t) * (1 - t) + 3 * p2x * t * t * (1 - t) + t * t * t;
    const by = (t) => 3 * p1y * t * (1 - t) * (1 - t) + 3 * p2y * t * t * (1 - t) + t * t * t;
    return (x) => {
      x = clamp(x, 0, 1);
      let lo = 0, hi = 1, t = x;
      for (let i = 0; i < 24; i += 1) {
        const cx = bx(t);
        if (Math.abs(cx - x) < 1e-4) break;
        if (cx < x) lo = t; else hi = t;
        t = (lo + hi) / 2;
      }
      return by(t);
    };
  }
  const sampled = (v) => (t) => {
    if (t <= 0) return v[0];
    if (t >= 1) return v[v.length - 1];
    const x = t * (v.length - 1);
    const i = Math.floor(x);
    return v[i] * (1 - (x - i)) + v[i + 1] * (x - i);
  };
  const SAMPLED = {
      "Overshoot": [0, 0.1739, 0.3067, 0.4183, 0.515, 0.6, 0.6755, 0.743, 0.8034, 0.8576, 0.9063, 0.95, 0.9891, 1.0241, 1.0551, 1.0825, 1.1066, 1.1275, 1.1455, 1.1606, 1.1731, 1.183, 1.1906, 1.1959, 1.199, 1.2, 1.1997, 1.1988, 1.1972, 1.195, 1.1921, 1.1886, 1.1846, 1.18, 1.1749, 1.1695, 1.1638, 1.1579, 1.1519, 1.1458, 1.1397, 1.1337, 1.1277, 1.1219, 1.1162, 1.1107, 1.1053, 1.1002, 1.0952, 1.0904, 1.0857, 1.0813, 1.077, 1.0729, 1.0689, 1.0651, 1.0615, 1.058, 1.0547, 1.0515, 1.0484, 1.0455, 1.0427, 1.0401, 1.0375, 1.0351, 1.0327, 1.0305, 1.0284, 1.0264, 1.0244, 1.0226, 1.0209, 1.0192, 1.0176, 1.0162, 1.0148, 1.0134, 1.0122, 1.011, 1.0099, 1.0088, 1.0079, 1.007, 1.0061, 1.0053, 1.0046, 1.0039, 1.0033, 1.0028, 1.0023, 1.0018, 1.0014, 1.0011, 1.0008, 1.0005, 1.0003, 1.0002, 1.0001, 1, 1],
      "Impulse": [0, -0.0006, -0.0023, -0.005, -0.0086, -0.0131, -0.0183, -0.0243, -0.0308, -0.038, -0.0456, -0.0537, -0.0622, -0.071, -0.0801, -0.0894, -0.0988, -0.1084, -0.1179, -0.1275, -0.1369, -0.1461, -0.1551, -0.1636, -0.1717, -0.1791, -0.1858, -0.1915, -0.1959, -0.1989, -0.2, -0.1986, -0.1944, -0.187, -0.1762, -0.1616, -0.1432, -0.1206, -0.0939, -0.0632, -0.0289, 0.0087, 0.0487, 0.0906, 0.1334, 0.1765, 0.2193, 0.2613, 0.3022, 0.3416, 0.3794, 0.4156, 0.4501, 0.483, 0.5142, 0.5438, 0.5719, 0.5986, 0.6239, 0.6478, 0.6705, 0.692, 0.7124, 0.7317, 0.75, 0.7673, 0.7837, 0.7993, 0.814, 0.8279, 0.841, 0.8535, 0.8652, 0.8763, 0.8868, 0.8967, 0.9059, 0.9147, 0.9229, 0.9305, 0.9377, 0.9444, 0.9507, 0.9565, 0.9619, 0.9669, 0.9714, 0.9756, 0.9794, 0.9829, 0.986, 0.9888, 0.9912, 0.9933, 0.9952, 0.9967, 0.9979, 0.9988, 0.9995, 0.9999, 1],
      "Swing": [0, -0.0013, -0.0052, -0.0115, -0.0199, -0.0302, -0.0421, -0.0554, -0.0697, -0.0847, -0.1, -0.1153, -0.1303, -0.1446, -0.1579, -0.1698, -0.1801, -0.1885, -0.1948, -0.1987, -0.2, -0.1986, -0.1942, -0.1863, -0.1744, -0.1578, -0.136, -0.1079, -0.0725, -0.0288, 0.0241, 0.087, 0.1594, 0.2396, 0.3241, 0.4088, 0.4899, 0.5651, 0.6332, 0.6941, 0.7482, 0.796, 0.8384, 0.8758, 0.9088, 0.9379, 0.9636, 0.9863, 1.0061, 1.0235, 1.0386, 1.0517, 1.0628, 1.0723, 1.0801, 1.0865, 1.0916, 1.0954, 1.098, 1.0995, 1.1, 1.0997, 1.0987, 1.097, 1.0947, 1.0919, 1.0885, 1.0847, 1.0806, 1.0762, 1.0717, 1.0671, 1.0624, 1.0578, 1.0533, 1.0489, 1.0447, 1.0406, 1.0368, 1.0332, 1.0297, 1.0265, 1.0235, 1.0207, 1.0181, 1.0157, 1.0135, 1.0115, 1.0097, 1.008, 1.0065, 1.0052, 1.0041, 1.0031, 1.0022, 1.0015, 1.001, 1.0005, 1.0002, 1.0001, 1],
      "Smooth Overshoot": [0, 0.0054, 0.0209, 0.0452, 0.0773, 0.116, 0.1602, 0.2088, 0.2611, 0.3159, 0.3725, 0.4301, 0.488, 0.5455, 0.6021, 0.6572, 0.7104, 0.7614, 0.8097, 0.8553, 0.8978, 0.9371, 0.9731, 1.0058, 1.0351, 1.0611, 1.0839, 1.1035, 1.1199, 1.1335, 1.1443, 1.1524, 1.1581, 1.1616, 1.1629, 1.1624, 1.1603, 1.1566, 1.1516, 1.1455, 1.1385, 1.1307, 1.1223, 1.1134, 1.1042, 1.0948, 1.0854, 1.076, 1.0667, 1.0576, 1.0489, 1.0404, 1.0324, 1.0249, 1.0178, 1.0113, 1.0052, 0.9998, 0.9948, 0.9904, 0.9866, 0.9832, 0.9804, 0.978, 0.9761, 0.9747, 0.9736, 0.9729, 0.9726, 0.9725, 0.9728, 0.9733, 0.974, 0.9748, 0.9759, 0.9771, 0.9783, 0.9797, 0.9811, 0.9826, 0.984, 0.9855, 0.9869, 0.9883, 0.9896, 0.9909, 0.9921, 0.9933, 0.9943, 0.9953, 0.9962, 0.9969, 0.9976, 0.9982, 0.9987, 0.9992, 0.9995, 0.9997, 0.9999, 1, 1],
      // Anticipate: winds back to −0.379 at 57.6 %, then snaps through to 1 (a Jitter exit ease, html/swing-pop-lab).
      "Anticipate": [0, -0.0105, -0.021, -0.0314, -0.0417, -0.052, -0.0621, -0.0721, -0.082, -0.0919, -0.1016, -0.1112, -0.1207, -0.1302, -0.1394, -0.1486, -0.1577, -0.1666, -0.1754, -0.1841, -0.1927, -0.2011, -0.2094, -0.2175, -0.2256, -0.2334, -0.2411, -0.2486, -0.256, -0.2633, -0.2703, -0.2773, -0.284, -0.2905, -0.2969, -0.3031, -0.309, -0.3148, -0.3203, -0.3257, -0.3309, -0.3358, -0.3405, -0.345, -0.3492, -0.3532, -0.357, -0.3604, -0.3636, -0.3666, -0.3692, -0.3716, -0.3737, -0.3754, -0.3768, -0.3779, -0.3786, -0.379, -0.3791, -0.3787, -0.3779, -0.3767, -0.3751, -0.373, -0.3705, -0.3674, -0.3639, -0.3598, -0.3552, -0.35, -0.3441, -0.3376, -0.3305, -0.3227, -0.314, -0.3046, -0.2944, -0.2833, -0.2712, -0.258, -0.2439, -0.2285, -0.2119, -0.1939, -0.1743, -0.1533, -0.1303, -0.1055, -0.0784, -0.0486, -0.0162, 0.0199, 0.0596, 0.104, 0.154, 0.2115, 0.2788, 0.3595, 0.4619, 0.609, 1],
  };
  const CURVE_FNS = (() => {
    const fam = (fin, name, inOut = 'Smooth') => ({ [`${name} In`]: fin, [`${name} Out`]: outOf(fin), [`${name} ${inOut}`]: inOutOf(fin) });
    return {
      Linear: (p) => p,
      'Ease In': powIn(3), 'Ease Out': outOf(powIn(3)), Smooth: inOutOf(powIn(3)),
      ...fam(powIn(2), 'Power1'), ...fam(powIn(3), 'Power2'), ...fam(powIn(4), 'Power3'), ...fam(powIn(5), 'Power4'),
      // The app plays "Cubic" as GSAP power3 (a quartic), so this does too.
      ...fam(powIn(4), 'Cubic'),
      ...fam(sineIn, 'Sine'), ...fam(expoIn, 'Expo'), ...fam(circIn, 'Circ'), ...fam(backIn, 'Back'),
      'Bounce Out': bounceOut,
      Elastic: elasticOut,
      Overshoot: sampled(SAMPLED.Overshoot),
      'Smooth Overshoot': sampled(SAMPLED['Smooth Overshoot']),
      Impulse: sampled(SAMPLED.Impulse),
      Swing: sampled(SAMPLED.Swing),
      Anticipate: sampled(SAMPLED.Anticipate),
      Natural: bezier(0.8, 0, 0.2, 1),
      'Slow Down': bezier(0, 0, 0, 1),
      'AE In': bezier(0.3141666673, 0, 0.0875000209, 1),
      'AE Smooth': bezier(0.8820833270, 0, 0.2445833683, 1),
      'AE Out': bezier(0.8699999754, 0, 0.6433336333, 1),
      'Smooth Glide': bezier(0.2111, 0.7721, 0.8541, 0.112),
      'Glide Easing Stop': bezier(0, 0.9125, 1, -0.0338),
    };
  })();
  // Custom plays its own handles; the last one is kept, since the drive asks every frame.
  let lastBez = null;
  const curveFn = (name, handles) => {
    if (name === 'Custom' && Array.isArray(handles) && handles.length === 4) {
      const key = handles.join(',');
      if (!lastBez || lastBez.key !== key) lastBez = { key, fn: bezier(...handles) };
      return lastBez.fn;
    }
    return CURVE_FNS[name] || CURVE_FNS['Ease Out'];
  };

  // ── Drives: Time and Voice ────────────────────────────────────────────────
  // Every unit takes a TURN. Time: Delay + rank × Stagger from the layer start, the
  // rank set by Order. Voice: when its word is spoken (the item's textWordTimings),
  // letters spread over their word, a line from its first word to its last. A turn
  // lasts until the next unit's turn (auto Hold). Out turns always run on the layer
  // clock and end at the layer's end: the last unit finishes exactly there, like Text
  // Animation's exit. Amounts may overshoot (Back, Bounce, Elastic …): transforms
  // follow them past rest, colour effects clamp.
  function ranksOf(order, N, seed) {
    const ranks = new Float32Array(Math.max(0, N));
    const c = (N - 1) / 2;
    const cMax = Math.floor(Math.max(0, c));
    const perm = order === 'random' ? seededPerm(N, seed) : null;
    let max = 0;
    for (let i = 0; i < N; i += 1) {
      let r;
      switch (order) {
        case 'backward': r = N - 1 - i; break;
        case 'center': r = Math.floor(Math.abs(i - c)); break;
        case 'edges': r = cMax - Math.floor(Math.abs(i - c)); break;
        case 'random': r = perm[i]; break;
        default: r = i;
      }
      ranks[i] = r;
      if (r > max) max = r;
    }
    return { ranks, max };
  }
  // Do these word timings describe this text? One window per whitespace word.
  function voiceFits(voice, counts) {
    return !!(voice && Array.isArray(voice.wins) && voice.wins.length > 0 && counts && voice.wins.length === counts.words);
  }
  // Voice turns per selector index, on the voice clock: t0 = the turn, t1 = when the
  // next unit's turn comes (a word stays "spoken" until the next word starts, or to
  // its own end when they overlap). Null when the timings don't fit the text.
  function voiceTurns(r, N, units, counts, voice) {
    if (!voiceFits(voice, counts) || !units) return null;
    const wins = voice.wins;
    const W = wins.length;
    const t0 = new Float64Array(N).fill(NaN);
    const t1 = new Float64Array(N).fill(NaN);
    const endOf = (w) => Math.max(wins[w].e, w + 1 < W ? wins[w + 1].s : wins[w].e);
    if (r.basedOn === 'words') {
      for (let k = 0; k < Math.min(N, W); k += 1) { t0[k] = wins[k].s; t1[k] = endOf(k); }
    } else if (r.basedOn === 'lines') {
      const first = new Map();
      const last = new Map();
      for (const u of units) {
        if (!(u.wi >= 0) || u.wi >= W) continue;
        if (!first.has(u.li)) first.set(u.li, u.wi);
        last.set(u.li, u.wi);
      }
      for (let k = 0; k < N; k += 1) {
        if (!first.has(k)) continue;
        t0[k] = wins[first.get(k)].s;
        t1[k] = endOf(last.get(k));
      }
    } else {
      const noSpace = r.basedOn === 'charsNoSpace';
      const len = new Map();
      for (const u of units) if (u.wi >= 0 && !u.space) len.set(u.wi, (len.get(u.wi) || 0) + 1);
      const seen = new Map();
      for (const u of units) {
        const k = noSpace ? u.cn : u.ci;
        if (!(k >= 0) || k >= N || !(u.wi >= 0) || u.wi >= W || u.space) continue;
        const j = seen.get(u.wi) || 0;
        seen.set(u.wi, j + 1);
        const L = len.get(u.wi) || 1;
        const w = wins[u.wi];
        if (r.spread) {
          t0[k] = w.s + ((w.e - w.s) * j) / L;
          t1[k] = j + 1 < L ? w.s + ((w.e - w.s) * (j + 1)) / L : endOf(u.wi);
        } else {
          t0[k] = w.s;
          t1[k] = endOf(u.wi);
        }
      }
    }
    // Anything left (a space between words under Characters): it takes its turn when
    // the unit before it is done, so a typing front passes straight over it.
    for (let k = 0; k < N; k += 1) {
      if (!Number.isNaN(t0[k])) continue;
      const prev = k > 0 && !Number.isNaN(t1[k - 1]) ? t1[k - 1] : (k > 0 ? t0[k - 1] : 0);
      t0[k] = Number.isNaN(prev) ? 0 : prev;
      t1[k] = t0[k];
    }
    return { t0, t1 };
  }
  // One amount per selector index for a Time / Voice animator, plus when it moves.
  //   ctx: { time, clipSec, units, counts, voice: { t, wins } | null }
  //   → { amounts, voiced, spans: [[a, b]] (layer clock, it moves only inside them),
  //       inEnd (layer clock: the in side is done), outStart (first out turn) }
  function driveAmounts(r, N, ctx) {
    const amounts = new Float32Array(Math.max(0, N));
    const res = { amounts, voiced: false, spans: [], inEnd: 0, outStart: Infinity };
    if (N <= 0) return res;
    const E = curveFn(r.curve, r.bezier);
    const d = Math.max(0, r.duration);
    const ramp = (t, t0, len) => (len > 1e-6 ? clamp((t - t0) / len, 0, 1) : (t >= t0 ? 1 : 0));
    const time = Number(ctx.time) || 0;
    const clip = Math.max(0, Number(ctx.clipSec) || 0);
    const vt = r.drive === 'voice' ? voiceTurns(r, N, ctx.units, ctx.counts, ctx.voice) : null;
    res.voiced = !!vt;
    const { ranks, max } = ranksOf(r.order, N, r.seed);
    const stagger = Math.max(0, r.stagger);
    const shift = vt ? (Number(ctx.voice.t) || 0) - time : 0; // voice clock − layer clock
    const hasIn = r.animate !== 'out';
    const hasOut = r.animate === 'out' || r.animate === 'inOut';
    // The in side's clock. Loop repeats a time cascade (Text Animation's highlight loop:
    // one sweep + the fade out + a 0.2 s breath).
    let tc = time + shift;
    let looping = false;
    if (!vt && r.loop && hasIn && !hasOut) {
      const period = r.animate === 'active' ? (max + 1) * stagger + r.fadeOut + 0.2 : max * stagger + d + 0.2;
      const tl = tc - r.delay;
      if (period > 1e-6) { looping = true; if (tl >= 0) tc = r.delay + (tl % period); }
    }
    const outSpan = max * stagger + d;
    const outT0 = (i) => clip - r.delay - outSpan + ranks[i] * stagger;
    let a0 = Infinity, a1 = -Infinity;
    for (let i = 0; i < N; i += 1) {
      const t0 = vt ? vt.t0[i] + r.delay : r.delay + ranks[i] * stagger;
      const t1 = vt ? vt.t1[i] + r.delay : t0 + stagger;
      let a;
      switch (r.animate) {
        case 'out': a = E(ramp(time, outT0(i), d)); break;
        case 'inOut': a = 1 - E(ramp(tc, t0, d)) + E(ramp(time, outT0(i), d)); break;
        case 'stay': a = E(ramp(tc, t0, d)); break;
        case 'active': {
          const isLast = vt ? i === N - 1 : ranks[i] === max;
          const off = isLast && r.keepLast && !looping ? Infinity : r.hold > 0 ? t0 + r.hold : t1;
          a = E(ramp(tc, t0, d));
          if (tc >= off) a = Math.min(a, r.fadeOut > 0 ? 1 - E(ramp(tc, off, r.fadeOut)) : 0);
          a1 = Math.max(a1, off === Infinity ? t0 + d : off + r.fadeOut);
          break;
        }
        default: a = 1 - E(ramp(tc, t0, d));
      }
      if (r.animate !== 'active') a1 = Math.max(a1, t0 + d);
      a0 = Math.min(a0, t0);
      amounts[i] = a;
    }
    if (hasIn) {
      res.inEnd = a1 - shift;
      res.spans.push(looping ? [r.delay - shift, Infinity] : [a0 - shift, a1 - shift]);
    }
    if (hasOut) {
      res.outStart = clip - r.delay - outSpan;
      res.spans.push([res.outStart, clip - r.delay]);
    }
    return res;
  }
  // Time / Voice counterpart of selection(): Amount and Wiggle apply as on a range.
  function driveSelection(r, w, N, time, ctx) {
    const res = driveAmounts(r, N, ctx);
    const out = res.amounts;
    const amt = r.amount / 100;
    for (let i = 0; i < N; i += 1) {
      let f = out[i] * amt;
      if (w) {
        const t = time * w.rate + w.tPhase / 360;
        const nu = noise1(t + i * (w.sPhase / 360), hashU32(w.seed, i + 1));
        const ng = noise1(t, hashU32(w.seed, 0));
        const v = lerp(nu, ng, w.corr / 100);
        f = combine(f, (w.min + ((v + 1) / 2) * (w.max - w.min)) / 100, w.mode);
      }
      out[i] = clamp(f, -2, 2);
    }
    return { amounts: out, S: null, E: null, drive: res };
  }

  // Selector index of a unit. Spaces have no index in "characters excluding
  // spaces" / "words": they take the smaller neighbour so a run stays whole.
  function unitIndex(u, basedOn) {
    switch (basedOn) {
      case 'charsNoSpace': return u.cn;
      case 'words': return u.wi;
      case 'lines': return u.li;
      default: return u.ci;
    }
  }
  function mapToUnits(units, basedOn, amounts) {
    const n = units.length;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i += 1) {
      const k = unitIndex(units[i], basedOn);
      out[i] = k >= 0 ? amounts[k] || 0 : NaN;
    }
    for (let i = 0; i < n; i += 1) {
      if (!Number.isNaN(out[i])) continue;
      const li = units[i].li;
      let a = NaN, b = NaN;
      for (let j = i - 1; j >= 0 && units[j].li === li; j -= 1) if (unitIndex(units[j], basedOn) >= 0) { a = out[j]; break; }
      for (let j = i + 1; j < n && units[j].li === li; j += 1) if (unitIndex(units[j], basedOn) >= 0) { b = out[j]; break; }
      out[i] = Number.isNaN(a) || Number.isNaN(b) ? 0 : Math.min(a, b);
    }
    return out;
  }

  // ── Colour helpers ────────────────────────────────────────────────────────
  function hexToRgb(h) {
    const n = parseInt(String(h).slice(1, 7), 16);
    return Number.isFinite(n) ? [(n >> 16) & 255, (n >> 8) & 255, n & 255] : [255, 255, 255];
  }
  const mixRgb = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
  function rgbToHsl([r, g, b]) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const l = (mx + mn) / 2;
    if (mx === mn) return [0, 0, l];
    const d = mx - mn;
    const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    let h;
    if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return [h * 60, s, l];
  }
  function hslToRgb([h, s, l]) {
    h = ((h % 360) + 360) % 360 / 360;
    if (s === 0) return [l * 255, l * 255, l * 255];
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const f = (t) => {
      if (t < 0) t += 1; if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
  }
  function shiftColor(c, dh, ds, db) {
    const [h, s, l] = rgbToHsl(c);
    const s2 = clamp(s * (1 + ds), 0, 1);
    const l2 = db >= 0 ? l + (1 - l) * db : l * (1 + db);
    return hslToRgb([h + dh, s2, clamp(l2, 0, 1)]);
  }
  const rgbCss = (c, a = 1) => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${a})`;

  // Gradient stops from a colour list. Shift slides the colours along the
  // gradient: Repeat off = the end colours extend (Shift 0 is the plain list),
  // Repeat on = the list loops (first colour repeated) so it can travel forever.
  function gradientStops(colors, shiftPct, repeat) {
    const rgb = colors.map(hexToRgb);
    if (!shiftPct && !repeat) return rgb.map((c, i) => ({ p: rgb.length > 1 ? i / (rgb.length - 1) : 0, c }));
    const list = repeat ? rgb.concat([rgb[0]]) : rgb;
    const at = (q) => {
      const x = (repeat ? ((q % 1) + 1) % 1 : clamp(q, 0, 1)) * (list.length - 1);
      const i = Math.min(Math.floor(x), list.length - 2);
      return mixRgb(list[i], list[i + 1], x - i);
    };
    const K = 16;
    const out = [];
    for (let i = 0; i <= K; i += 1) out.push({ p: i / K, c: at(i / K - shiftPct / 100) });
    return out;
  }
  function sampleStops(stops, p) {
    if (p <= stops[0].p) return stops[0].c;
    for (let i = 0; i < stops.length - 1; i += 1) {
      const a = stops[i], b = stops[i + 1];
      if (p <= b.p) return mixRgb(a.c, b.c, b.p > a.p ? (p - a.p) / (b.p - a.p) : 0);
    }
    return stops[stops.length - 1].c;
  }
  // The unit's paint as a CSS string: `rgb()` or a `linear-gradient()` whose angle
  // follows CSS (our 0° = left → right = CSS 90deg). Null while untouched.
  function paintCss(p) {
    if (!p) return null;
    const c = (x) => `rgb(${Math.round(x[0])}, ${Math.round(x[1])}, ${Math.round(x[2])})`;
    if (p.type === 'solid') return p.c ? c(p.c) : null;
    return `linear-gradient(${round3(p.angle + 90)}deg, ${p.stops.map((s) => `${c(s.c)} ${round3(s.p * 100)}%`).join(', ')})`;
  }
  const round3 = (v) => Math.round(v * 1000) / 1000;

  // Paint folding. With a KNOWN base colour (solid text): solid over solid = mix;
  // gradient over solid = a gradient whose stops are pre-mixed (exact — one draw);
  // gradient over a gradient of the SAME geometry = resampled mix; different
  // geometry → an overlay pass. With an UNKNOWN base (the layer's text colour is a
  // CSS gradient) the paint is an OVERLAY of coverage `paintK` drawn over the
  // untouched base: colour and coverage accumulate like stacked alpha layers.
  function accumulate(cOld, kOld, rgb, k) {
    const kNew = 1 - (1 - kOld) * (1 - k);
    if (!cOld || kNew <= 1e-6) return { c: rgb.slice(), k: kNew };
    const a = (kOld * (1 - k)) / kNew;
    const b = k / kNew;
    return { c: [cOld[0] * a + rgb[0] * b, cOld[1] * a + rgb[1] * b, cOld[2] * a + rgb[2] * b], k: kNew };
  }
  function paintFill(st, rgb, k) {
    const p = st.paint;
    st.touched = true;
    if (st.baseKnown) {
      if (p.type === 'solid') p.c = mixRgb(p.c, rgb, k);
      else p.stops = p.stops.map((s) => ({ p: s.p, c: mixRgb(s.c, rgb, k) }));
      return;
    }
    const k0 = st.paintK;
    if (p.type === 'solid') { const r = accumulate(p.c, k0, rgb, k); p.c = r.c; st.paintK = r.k; }
    else { p.stops = p.stops.map((s) => ({ p: s.p, c: accumulate(s.c, k0, rgb, k).c })); st.paintK = 1 - (1 - k0) * (1 - k); }
  }
  function paintGradient(st, g, k) {
    const p = st.paint;
    st.touched = true;
    if (p.type === 'solid') {
      const k0 = st.paintK;
      st.paint = {
        type: 'grad', angle: g.angle, span: g.span,
        stops: g.stops.map((s) => ({ p: s.p, c: st.baseKnown ? mixRgb(p.c, s.c, k) : accumulate(p.c, k0, s.c, k).c })),
      };
      if (!st.baseKnown) st.paintK = 1 - (1 - k0) * (1 - k);
      return;
    }
    if (p.angle === g.angle && p.span === g.span) {
      const ps = Array.from(new Set(p.stops.map((s) => s.p).concat(g.stops.map((s) => s.p)))).sort((a, b) => a - b);
      const k0 = st.paintK;
      p.stops = ps.map((q) => ({ p: q, c: st.baseKnown ? mixRgb(sampleStops(p.stops, q), sampleStops(g.stops, q), k) : accumulate(sampleStops(p.stops, q), k0, sampleStops(g.stops, q), k).c }));
      if (!st.baseKnown) st.paintK = 1 - (1 - k0) * (1 - k);
      return;
    }
    (st.overlays || (st.overlays = [])).push({ type: 'grad', angle: g.angle, span: g.span, stops: g.stops, alpha: k });
  }
  function paintHue(st, dh, ds, db) {
    const p = st.paint;
    if (p.type === 'solid') { if (p.c) { p.c = shiftColor(p.c, dh, ds, db); st.touched = true; } }
    else { p.stops = p.stops.map((s) => ({ p: s.p, c: shiftColor(s.c, dh, ds, db) })); st.touched = true; }
    if (st.overlays) for (const o of st.overlays) o.stops = o.stops.map((s) => ({ p: s.p, c: shiftColor(s.c, dh, ds, db) }));
  }

  function shiftChar(ch, n) {
    if (!n) return ch;
    const code = ch.charCodeAt(0);
    const wrap = (base, len) => String.fromCharCode(base + ((((code - base + n) % len) + len) % len));
    if (code >= 65 && code <= 90) return wrap(65, 26);
    if (code >= 97 && code <= 122) return wrap(97, 26);
    if (code >= 48 && code <= 57) return wrap(48, 10);
    return ch;
  }

  // ── Evaluate one frame ────────────────────────────────────────────────────
  // units:  [{ ch, space, ci, cn, wi, li, base? }]   (layout positions live in the caller)
  //         `base`: the unit's own colour as [r,g,b], or null when it is a CSS
  //         gradient (the paint then becomes an overlay); absent = baseColor.
  // counts: { chars, charsNoSpace, words, lines }
  // value(aid, chan, stored) → the keyframed value at this instant, or stored.
  // clipSec: the layer's length (Out turns end there). voice: { t, wins } — the voice
  // clock now and one spoken window { s, e } per whitespace word, same clock; null or
  // not one per word → Voice animators run as Time.
  function freshState(base) {
    return {
      xf: null, track: 0, alpha: 1, blur: 0, mask: null, maskMoves: null,
      baseKnown: !!base, touched: false, paintK: 0,
      paint: { type: 'solid', c: base ? base.slice() : null }, overlays: null,
      stroke: null, outlineK: 0, glows: null, shadow: null, scramble: null, charShift: 0,
    };
  }
  // A range with the instant's keyframed values in it.
  function rangeAt(an, val) {
    const r = { ...an.range };
    const driven = r.drive === 'time' || r.drive === 'voice';
    for (const [k, f] of Object.entries(RANGE_FIELDS)) {
      if (f.kf && !(driven && RANGE_ONLY[k])) r[k] = clamp(val(an.aid, k, r[k]), f.min, f.max);
    }
    return r;
  }
  function evaluate({ animators, units, counts, time, value, baseColor, clipSec = 0, voice = null }) {
    const n = units.length;
    const baseRgb = hexToRgb(baseColor || '#ffffff');
    const states = new Array(n);
    for (let i = 0; i < n; i += 1) states[i] = freshState('base' in units[i] ? units[i].base : baseRgb);
    const boxes = [];
    const carets = [];
    const selections = {};
    const val = value || ((aid, chan, stored) => stored);
    const dctx = { time, clipSec, units, counts, voice };
    let outStart = Infinity;
    for (const an of animators || []) {
      if (!an || an.enabled === false) continue;
      const effects = (an.effects || []).filter((e) => e && e.enabled !== false && EFFECT_BY_KEY[e.type]);
      if (!effects.length) continue;
      const r = rangeAt(an, val);
      let w = null;
      if (an.wiggle && an.wiggle.enabled) {
        w = { ...an.wiggle };
        for (const [k, f] of Object.entries(WIGGLE_FIELDS)) if (f.kf) w[k] = clamp(val(an.aid, `wig.${k}`, w[k]), f.min, f.max);
      }
      const N = counts[r.basedOn] || 0;
      const level = levelOf(r);
      const driven = r.drive === 'time' || r.drive === 'voice';
      const sel = driven ? driveSelection(r, w, N, time, dctx) : selection(r, w, N, time);
      const amt = mapToUnits(units, r.basedOn, sel.amounts);
      selections[an.aid] = { amounts: sel.amounts, unitAmounts: amt, S: sel.S, E: sel.E, N, basedOn: r.basedOn, drive: driven ? r.drive : 'range', voiced: !!(sel.drive && sel.drive.voiced) };
      if (sel.drive) outStart = Math.min(outStart, sel.drive.outStart);
      if (r.mask && hasTransform(an)) for (const st of states) if (!st.mask) st.mask = level;
      for (const fx of effects) {
        const def = EFFECT_BY_KEY[fx.type];
        const v = {};
        // A field the effect was saved without (added later) reads its default.
        for (const [k, f] of Object.entries(def.fields)) {
          const stored = fx[k] === undefined ? f.default : fx[k];
          v[k] = f.type === 'num' && f.kf ? clamp(val(an.aid, `${fx.pid}.${k}`, stored), f.min, f.max) : stored;
        }
        if (fx.type === 'box') {
          // groups: each unit's index in the animator's Based on (−1 = none, a space
          // between words), so Per unit bars a whole word even when it is drawn by letters.
          const groups = v.shape === 'unit' ? Int32Array.from(units, (u) => { const g = unitIndex(u, r.basedOn); return g >= 0 ? g : -1; }) : null;
          boxes.push({ v, amt: v.behind === 'revealed' ? revealedOf(amt) : amt, groups });
          continue;
        }
        if (fx.type === 'caret') { carets.push({ v, amt: revealedOf(amt), inEnd: sel.drive ? sel.drive.inEnd : null }); continue; }
        let g = null;
        if (fx.type === 'gradient') g = { angle: v.angle, span: v.span, stops: gradientStops(v.colors, v.shift, v.repeat) };
        const fillRgb = fx.type === 'fill' ? hexToRgb(v.color) : null;
        for (let i = 0; i < n; i += 1) {
          const k = amt[i];
          if (!(Math.abs(k) > 1e-4)) continue;
          applyEffect(states[i], fx.type, v, k, i, time, g, fillRgb, level);
          // A masked rise must clear its mask: the host stretches this move with maskedXf.
          if (r.mask && fx.type === 'position' && v.y) (states[i].maskMoves || (states[i].maskMoves = [])).push({ level, y: v.y, k });
        }
      }
    }
    for (const st of states) { st.alpha = clamp(st.alpha, 0, 1); st.blur = Math.max(0, st.blur); }
    // Fade with text (Per unit): a bar is as visible as its unit, every animator's
    // opacity included — known only now that all of them have run.
    for (const b of boxes) if (b.v.withText && b.v.shape === 'unit') b.amt = Float32Array.from(b.amt, (a, i) => a * (states[i] ? states[i].alpha : 1));
    // A caret goes once the first unit starts to leave (Text Animation's caret does too).
    for (const c of carets) c.outStart = outStart;
    return { states, boxes, carets, selections };
  }

  // A unit's transforms, one sum per level it turns around: st.xf = { char?, word?,
  // line?, all? } (null = untouched).
  function xfOf(st, level) {
    const xf = st.xf || (st.xf = {});
    return xf[level] || (xf[level] = { tx: 0, ty: 0, s: 1, sx: 1, sy: 1, rot: 0, rx: 0, ry: 0, skew: 0, axis: 0, persp: 0 });
  }
  function applyEffect(st, type, v, k, i, time, g, fillRgb, level = 'char') {
    const kp = clamp(k, 0, 1); // colour-type effects don't extrapolate
    switch (type) {
      case 'position': { const e = xfOf(st, level); e.tx += v.x * k; e.ty += v.y * k; break; }
      case 'scale': { const e = xfOf(st, level); e.s *= 1 + (v.scale / 100 - 1) * k; e.sx *= 1 + (v.x / 100 - 1) * k; e.sy *= 1 + (v.y / 100 - 1) * k; break; }
      case 'rotation': { const e = xfOf(st, level); e.rot += v.angle * k; break; }
      case 'rotate3d': { const e = xfOf(st, level); e.rx += v.x * k; e.ry += v.y * k; e.persp = v.perspective; break; }
      case 'skew': { const e = xfOf(st, level); e.skew += v.skew * k; e.axis = v.axis; break; }
      case 'tracking': st.track += v.amount * k; break;
      case 'opacity': st.alpha *= 1 + (v.opacity / 100 - 1) * kp; break;
      case 'blur': st.blur += v.amount * k; break;
      case 'fill': if (kp > 0) paintFill(st, fillRgb, kp * (v.mix / 100)); break;
      case 'gradient': if (kp > 0) paintGradient(st, g, kp * (v.mix / 100)); break;
      case 'hue': paintHue(st, v.hue * k, (v.saturation / 100) * k, (v.brightness / 100) * k); break;
      case 'stroke': {
        if (kp <= 0) break;
        const rgb = hexToRgb(v.color);
        const prev = st.stroke;
        st.stroke = prev ? { c: mixRgb(prev.c, rgb, kp), w: prev.w + v.width * kp } : { c: rgb, w: v.width * kp };
        if (v.outline) st.outlineK = Math.max(st.outlineK, kp);
        break;
      }
      case 'glow': if (kp > 0) (st.glows || (st.glows = [])).push({ c: hexToRgb(v.color), size: v.size, alpha: (v.strength / 100) * kp }); break;
      case 'shadow': if (kp > 0) st.shadow = { c: hexToRgb(v.color), x: v.x * kp, y: v.y * kp, blur: v.blur * kp, alpha: (v.opacity / 100) * kp }; break;
      case 'scramble': {
        if (kp <= 0) break;
        const frame = v.rate > 0 ? Math.floor(time * v.rate) : 0;
        if (kp >= 1 || hash01(i * 2 + 1, hashU32(v.seed, frame)) < kp) {
          st.scramble = { set: CHARSETS[v.charset] || CHARSETS.upper, h: hashU32(v.seed + 31, frame), i };
        }
        break;
      }
      case 'charOffset': st.charShift += v.offset * k; break;
      default: break;
    }
  }

  // Text actually drawn for a unit — a character, a word or a line. Scramble wins
  // over character offset; spaces stay spaces.
  function glyphFor(st, token) {
    if (st.scramble) {
      const { set, h, i } = st.scramble;
      let off = 0;
      return Array.from(token).map((ch) => (/\s/.test(ch) ? ch : set[Math.floor(hash01(i * 131 + (off++), h) * set.length) % set.length])).join('');
    }
    const n = Math.round(st.charShift);
    return n ? Array.from(token).map((ch) => shiftChar(ch, n)).join('') : token;
  }

  // ── Transforms: levels, pivots, perspective ───────────────────────────────
  const LEVELS = ['char', 'word', 'line', 'all'];
  const XF_TYPES = { position: 1, scale: 1, rotation: 1, rotate3d: 1, skew: 1 };
  // The unit an animator's transforms turn around: its Transform around, or the
  // unit it is Based on.
  function levelOf(r) {
    if (r && r.around && r.around !== 'auto') return r.around;
    const b = r && r.basedOn;
    return b === 'words' ? 'word' : b === 'lines' ? 'line' : 'char';
  }
  // Every unit's box at each level, from the units' own INK boxes (layout, before
  // any transform): cells [{ x0, y0, x1, y1, wi, li }] → (i, level) → box. x1 = the
  // ink's right edge: a word unit's trailing space, or a space unit (x1 = x0), adds
  // nothing, so a word turns around its letters however the layer splits the text.
  // A unit with no word (a space) is its own word.
  function groupBoxes(cells) {
    const word = new Map();
    const line = new Map();
    let all = null;
    const grow = (b, c) => {
      if (!b) return { x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1 };
      b.x0 = Math.min(b.x0, c.x0); b.y0 = Math.min(b.y0, c.y0);
      b.x1 = Math.max(b.x1, c.x1); b.y1 = Math.max(b.y1, c.y1);
      return b;
    };
    for (const c of cells) {
      if (!(c.x1 > c.x0)) continue;
      if (c.wi >= 0) word.set(c.wi, grow(word.get(c.wi), c));
      line.set(c.li, grow(line.get(c.li), c));
      all = grow(all, c);
    }
    return (i, level) => {
      const c = cells[i];
      const b = level === 'all' ? all : level === 'line' ? line.get(c.li) : level === 'word' && c.wi >= 0 ? word.get(c.wi) : null;
      return b || c;
    };
  }

  // 3×3 homography, row-major: x' = (h0 x + h1 y + h2) / w, y' = (h3 x + h4 y + h5) / w,
  // w = h6 x + h7 y + h8.
  function hMul(A, B) {
    const o = new Array(9);
    for (let r = 0; r < 3; r += 1) {
      for (let c = 0; c < 3; c += 1) o[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
    }
    return o;
  }
  function applyH(H, x, y) {
    const w = H[6] * x + H[7] * y + H[8];
    if (!(w > 1e-6)) return null;
    return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
  }
  // An affine H (not projective) in canvas order [a b c d e f].
  function hToCanvas(H) {
    const w = H[8] || 1;
    return [H[0] / w, H[3] / w, H[1] / w, H[4] / w, H[2] / w, H[5] / w];
  }
  // The nearest point of a unit may come at most this close: w = its distance over
  // the pivot plane's. A unit bigger than its Perspective flattens instead of
  // passing the camera.
  const W_NEAR = 0.25;
  // One level's transform around pivot P in its box: scale, skew, Rotate 3D (X
  // first: + tips the top away; then Y: + turns the right side away), rotation,
  // then the move. Depth projects from a camera Perspective px in front of the
  // box centre (CSS perspective at the unit's centre), riding the move.
  function levelH(e, box, pivot) {
    const cx = (box.x0 + box.x1) / 2;
    const cy = (box.y0 + box.y1) / 2;
    const px = cx + (pivot.x * (box.x1 - box.x0)) / 2;
    const py = cy + (pivot.y * (box.y1 - box.y0)) / 2;
    // KS = skew · scale; skew along an axis = R(axis) · shearX(−tan skew) · R(−axis)
    const sx = e.s * e.sx;
    const sy = e.s * e.sy;
    let k00 = 1, k01 = 0, k10 = 0, k11 = 1;
    if (e.skew) {
      const t = Math.tan((clamp(e.skew, -85, 85) * Math.PI) / 180);
      const ca = Math.cos((e.axis * Math.PI) / 180);
      const sa = Math.sin((e.axis * Math.PI) / 180);
      k00 = 1 + t * ca * sa; k01 = -t * ca * ca; k10 = t * sa * sa; k11 = 1 - t * sa * ca;
    }
    const a00 = k00 * sx, a01 = k01 * sy, a10 = k10 * sx, a11 = k11 * sy;
    // Rotate 3D: the rotated plane's x / y / depth rows (Ry · Rx, depth + = away)
    const th = (e.rx * Math.PI) / 180;
    const ph = (e.ry * Math.PI) / 180;
    const ct = Math.cos(th), st = Math.sin(th), cp = Math.cos(ph), sp = Math.sin(ph);
    const r00 = cp, r01 = sp * st, r11 = ct;
    const z0 = sp, z1 = -cp * st;
    const p00 = r00 * a00 + r01 * a10, p01 = r00 * a01 + r01 * a11;
    const p10 = r11 * a10, p11 = r11 * a11;
    const m0 = z0 * a00 + z1 * a10, m1 = z0 * a01 + z1 * a11;
    // in-plane rotation
    const rad = (e.rot * Math.PI) / 180;
    const cr = Math.cos(rad), sr = Math.sin(rad);
    const b00 = cr * p00 - sr * p10, b01 = cr * p01 - sr * p11;
    const b10 = sr * p00 + cr * p10, b11 = sr * p01 + cr * p11;
    let invD = 0;
    if (e.persp > 0 && (Math.abs(m0) > 1e-9 || Math.abs(m1) > 1e-9)) {
      let D = e.persp;
      let near = 0;
      for (const [x, y] of [[box.x0, box.y0], [box.x1, box.y0], [box.x0, box.y1], [box.x1, box.y1]]) near = Math.min(near, m0 * (x - px) + m1 * (y - py));
      if (near < 0) D = Math.max(D, -near / (1 - W_NEAR));
      invD = 1 / D;
    }
    const vx = cx + e.tx;
    const vy = cy + e.ty;
    const q = [
      b00 + vx * m0 * invD, b01 + vx * m1 * invD, px + e.tx,
      b10 + vy * m0 * invD, b11 + vy * m1 * invD, py + e.ty,
      m0 * invD, m1 * invD, 1,
    ];
    // … around P: q · translate(−P)
    for (let r = 0; r < 3; r += 1) q[r * 3 + 2] -= q[r * 3] * px + q[r * 3 + 1] * py;
    return { H: q, projective: invD > 0 };
  }
  // A unit's whole transform: its levels composed finest first. boxOf(level) = the
  // unit's box at that level (groupBoxes); pivot = Pivot X / Y as −1…1.
  // → { H, projective } or null when no transform touches it. Not projective =
  // hToCanvas(H) is all a canvas needs; projective = draw with warpBegin / warpEnd.
  // Mask: a vertical Position under a mask travels at least the height of the unit's
  // mask box (boxH), so at full amount the unit has wholly left it, whatever Y says — a
  // shorter move would show the letters before they start (Text Animation's mask did the
  // same with the line height). X is left as set. Returns the unit's xf with the stretch
  // folded in (a copy; st stays as evaluated), or st.xf when nothing needs it.
  function maskedXf(st, boxH) {
    if (!st.maskMoves || !st.xf || !(boxH > 0)) return st.xf;
    let xf = null;
    for (const m of st.maskMoves) {
      const extra = m.k * (Math.sign(m.y) * Math.max(Math.abs(m.y), boxH) - m.y);
      if (!extra) continue;
      if (!xf) { xf = {}; for (const lv of Object.keys(st.xf)) xf[lv] = { ...st.xf[lv] }; }
      xf[m.level].ty += extra;
    }
    return xf || st.xf;
  }

  // ── The same transform as a REAL 3D matrix (3D Text, text3d.js) ─────────────
  // levelH projects Rotate 3D onto the plate (a homography); a solid letter needs
  // the turn itself. Same order and pivots as levelH — scale and skew, then
  // Rotate 3D (Ry · Rx, the rotation whose x / y / depth rows levelH projects),
  // then the in-plane rotation, then the move — in plate space (x right, y DOWN,
  // z AWAY from the viewer). The perspective is the project camera's, so `persp`
  // has nothing to do here. Row-major 4×4.
  function m4Mul(A, B) {
    const C = new Array(16);
    for (let r = 0; r < 4; r += 1) {
      for (let c = 0; c < 4; c += 1) {
        C[r * 4 + c] = A[r * 4] * B[c] + A[r * 4 + 1] * B[4 + c] + A[r * 4 + 2] * B[8 + c] + A[r * 4 + 3] * B[12 + c];
      }
    }
    return C;
  }
  function levelM4(e, box, pivot) {
    const cx = (box.x0 + box.x1) / 2;
    const cy = (box.y0 + box.y1) / 2;
    const px = cx + (pivot.x * (box.x1 - box.x0)) / 2;
    const py = cy + (pivot.y * (box.y1 - box.y0)) / 2;
    const sx = e.s * e.sx;
    const sy = e.s * e.sy;
    let k00 = 1, k01 = 0, k10 = 0, k11 = 1;
    if (e.skew) {
      const t = Math.tan((clamp(e.skew, -85, 85) * Math.PI) / 180);
      const ca = Math.cos((e.axis * Math.PI) / 180);
      const sa = Math.sin((e.axis * Math.PI) / 180);
      k00 = 1 + t * ca * sa; k01 = -t * ca * ca; k10 = t * sa * sa; k11 = 1 - t * sa * ca;
    }
    const a00 = k00 * sx, a01 = k01 * sy, a10 = k10 * sx, a11 = k11 * sy;
    const az = e.s;
    const th = (e.rx * Math.PI) / 180;
    const ph = (e.ry * Math.PI) / 180;
    const ct = Math.cos(th), st = Math.sin(th), cp = Math.cos(ph), sp = Math.sin(ph);
    // Columns: the turned x axis (cp, 0, sp), y axis (sp·st, ct, −cp·st) — exactly
    // levelH's rows — and their cross product for depth.
    const R = [cp, sp * st, -sp * ct, 0, ct, st, sp, -cp * st, cp * ct];
    const rad = (e.rot * Math.PI) / 180;
    const cr = Math.cos(rad), sr = Math.sin(rad);
    // L = Rz · R · A
    const RA = [
      R[0] * a00 + R[1] * a10, R[0] * a01 + R[1] * a11, R[2] * az,
      R[3] * a00 + R[4] * a10, R[3] * a01 + R[4] * a11, R[5] * az,
      R[6] * a00 + R[7] * a10, R[6] * a01 + R[7] * a11, R[8] * az,
    ];
    const L = [
      cr * RA[0] - sr * RA[3], cr * RA[1] - sr * RA[4], cr * RA[2] - sr * RA[5],
      sr * RA[0] + cr * RA[3], sr * RA[1] + cr * RA[4], sr * RA[2] + cr * RA[5],
      RA[6], RA[7], RA[8],
    ];
    // translate(P + move) · L · translate(−P)
    const tx = px + e.tx - (L[0] * px + L[1] * py);
    const ty = py + e.ty - (L[3] * px + L[4] * py);
    const tz = -(L[6] * px + L[7] * py);
    return [L[0], L[1], L[2], tx, L[3], L[4], L[5], ty, L[6], L[7], L[8], tz, 0, 0, 0, 1];
  }
  function unitTransform3d(xf, boxOf, pivot) {
    let M = null;
    for (const lv of LEVELS) {
      const e = xf && xf[lv];
      if (!e) continue;
      const r = levelM4(e, boxOf(lv), pivot);
      M = M ? m4Mul(r, M) : r;
    }
    return M;
  }

  function unitTransform(xf, boxOf, pivot) {
    let H = null;
    let projective = false;
    for (const lv of LEVELS) {
      const e = xf && xf[lv];
      if (!e) continue;
      const r = levelH(e, boxOf(lv), pivot);
      H = H ? hMul(r.H, H) : r.H;
      if (r.projective) projective = true;
    }
    return H ? { H, projective } : null;
  }

  // ── Perspective on a 2D canvas ────────────────────────────────────────────
  // Canvas 2D has no projective transform. A unit with depth is painted FLAT into
  // scratch.a at the target's own device scale (shadow, blur and glow sizes are
  // device px, so they come out as they would unwarped), then cut into a grid of
  // triangles, each drawn into scratch.b with its own affine: 'copy' inside a clip
  // grown by a pixel, so a triangle REPLACES its neighbour's antialiased edge
  // instead of blending over it (no seam, no doubled edge). scratch.b lands on the
  // target in one drawImage. The grid is as fine as the depth needs (≈ ⅓ px off).
  //
  //   const w = warpBegin(ctx, H, box, scratch, padDev);
  //   if (w) { …paint the unit flat on w.ctx, in ctx's CURRENT frame…; warpEnd(w); }
  //
  // w.ctx starts with ctx's drawing state (font, paints, shadow, filter, alpha) and
  // its transform set to ctx's frame → scratch px (w.base, canvas order). w = null:
  // nothing would show (edge-on, behind the camera, off the canvas).
  //   box      the frame's box that holds the unit before H
  //   padDev   device px the paint reaches past the box (blur, shadow, glow)
  //   scratch  { a, b }: canvases the caller keeps; they only ever grow
  const WARP_MAX = 4096;
  const WARP_TOL = 0.35;
  const WARP_CELLS = 600;
  const WARP_STATE = ['font', 'textAlign', 'textBaseline', 'direction', 'fontKerning', 'letterSpacing', 'wordSpacing',
    'fontStretch', 'fontVariantCaps', 'textRendering', 'fillStyle', 'strokeStyle', 'lineWidth', 'lineJoin', 'lineCap',
    'miterLimit', 'lineDashOffset', 'globalAlpha', 'filter', 'shadowColor', 'shadowBlur', 'shadowOffsetX', 'shadowOffsetY',
    'imageSmoothingEnabled', 'imageSmoothingQuality'];
  function freshContext(cv, w, h) {
    if (cv.width < w || cv.height < h) {
      cv.width = Math.max(cv.width, w);
      cv.height = Math.max(cv.height, h);
    }
    const c = cv.getContext('2d');
    if (c.reset) c.reset();
    else { c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, cv.width, cv.height); }
    return c;
  }
  function warpBegin(ctx, H, box, scratch, padDev = 0) {
    const T = ctx.getTransform();
    const t = [T.a, T.b, T.c, T.d, T.e, T.f];
    let s = Math.max(Math.hypot(t[0], t[1]), Math.hypot(t[2], t[3]));
    if (!(s > 1e-6)) return null;
    const pad = (Math.max(0, padDev) + 1) / s;
    const x0 = box.x0 - pad, y0 = box.y0 - pad, x1 = box.x1 + pad, y1 = box.y1 + pad;
    const dev = (x, y) => {
      const p = applyH(H, x, y);
      return p && [t[0] * p[0] + t[2] * p[1] + t[4], t[1] * p[0] + t[3] * p[1] + t[5]];
    };
    const c = [dev(x0, y0), dev(x1, y0), dev(x1, y1), dev(x0, y1)];
    if (c.some((p) => !p)) return null;
    let area = 0;
    for (let i = 0; i < 4; i += 1) area += c[i][0] * c[(i + 1) % 4][1] - c[(i + 1) % 4][0] * c[i][1];
    if (Math.abs(area) < 1) return null;
    const cv = ctx.canvas;
    const xs = c.map((p) => p[0]), ys = c.map((p) => p[1]);
    const bx0 = Math.max(0, Math.floor(Math.min(...xs)) - 2);
    const by0 = Math.max(0, Math.floor(Math.min(...ys)) - 2);
    const bx1 = Math.min(cv.width, Math.ceil(Math.max(...xs)) + 2);
    const by1 = Math.min(cv.height, Math.ceil(Math.max(...ys)) + 2);
    if (bx1 - bx0 < 1 || by1 - by0 < 1 || bx1 - bx0 > WARP_MAX || by1 - by0 > WARP_MAX) return null;
    const big = Math.max(x1 - x0, y1 - y0) * s;
    if (big > WARP_MAX) s *= WARP_MAX / big;
    const wA = Math.max(1, Math.ceil((x1 - x0) * s));
    const hA = Math.max(1, Math.ceil((y1 - y0) * s));
    const ca = freshContext(scratch.a, wA, hA);
    for (const k of WARP_STATE) if (k in ctx) { try { ca[k] = ctx[k]; } catch { /* read-only in this engine */ } }
    if (ctx.getLineDash) ca.setLineDash(ctx.getLineDash());
    const base = [s, 0, 0, s, -x0 * s, -y0 * s];
    ca.setTransform(base[0], base[1], base[2], base[3], base[4], base[5]);
    ca.save();
    return { ctx: ca, base, plate: ctx, H, t, s, x0, y0, wA, hA, bx0, by0, bx1, by1, scratch };
  }
  // Grow a triangle by d px on every side (mitred, capped for slivers).
  function growTriangle(p, d) {
    const area = (p[1][0] - p[0][0]) * (p[2][1] - p[0][1]) - (p[2][0] - p[0][0]) * (p[1][1] - p[0][1]);
    const sg = area > 0 ? 1 : -1;
    const n = [0, 1, 2].map((i) => {
      const a = p[i], b = p[(i + 1) % 3];
      const ex = b[0] - a[0], ey = b[1] - a[1];
      const l = Math.hypot(ex, ey) || 1;
      return [(sg * ey) / l, (-sg * ex) / l];
    });
    return [0, 1, 2].map((i) => {
      const na = n[(i + 2) % 3], nb = n[i];
      let mx = na[0] + nb[0], my = na[1] + nb[1];
      const k = 1 + na[0] * nb[0] + na[1] * nb[1];
      mx /= Math.max(k, 1e-3); my /= Math.max(k, 1e-3);
      const ml = Math.hypot(mx, my);
      if (ml > 4) { mx *= 4 / ml; my *= 4 / ml; }
      return [p[i][0] + mx * d, p[i][1] + my * d];
    });
  }
  function warpEnd(w) {
    const { H, t, s, x0, y0, wA, hA, bx0, by0, bx1, by1, scratch, plate } = w;
    const wB = bx1 - bx0, hB = by1 - by0;
    // Scratch px (u, v) → scratch.b px.
    const at = (u, v) => {
      const x = x0 + u / s, y = y0 + v / s;
      const ww = H[6] * x + H[7] * y + H[8];
      const X = (H[0] * x + H[1] * y + H[2]) / ww, Y = (H[3] * x + H[4] * y + H[5]) / ww;
      return [t[0] * X + t[2] * Y + t[4] - bx0, t[1] * X + t[3] * Y + t[5] - by0];
    };
    // Grid: a triangle is affine, the projection is not. A c × c px cell strays from
    // it by about c² (2 (gu + gv) + R (gu² + gv²)) / 4 px — the keystone (one side of
    // a cell taller than the other) plus the bend along each axis; gu / gv = how
    // fast the depth ratio w changes per px along u / v, R = the unit's reach.
    const wOf = (u, v) => H[6] * (x0 + u / s) + H[7] * (y0 + v / s) + H[8];
    const w00 = wOf(0, 0), w10 = wOf(wA, 0), w01 = wOf(0, hA), w11 = wOf(wA, hA);
    const wMin = Math.min(w00, w10, w01, w11);
    const c00 = at(0, 0), c10 = at(wA, 0), c01 = at(0, hA), c11 = at(wA, hA);
    const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    const R = Math.max(dist(c00, c11), dist(c10, c01));
    const Lu = Math.max(1, dist(c00, c10), dist(c01, c11));
    const Lv = Math.max(1, dist(c00, c01), dist(c10, c11));
    const gu = Math.max(Math.abs(w10 - w00), Math.abs(w11 - w01)) / wMin / Lu;
    const gv = Math.max(Math.abs(w01 - w00), Math.abs(w11 - w10)) / wMin / Lv;
    const K = 2 * (gu + gv) + R * (gu * gu + gv * gv);
    const cell = K > 1e-12 ? Math.sqrt((4 * WARP_TOL) / K) : Infinity;
    let nu = clamp(Math.ceil(Lu / cell), 1, 64);
    let nv = clamp(Math.ceil(Lv / cell), 1, 64);
    if (nu * nv > WARP_CELLS) { const f = Math.sqrt(WARP_CELLS / (nu * nv)); nu = Math.max(1, Math.round(nu * f)); nv = Math.max(1, Math.round(nv * f)); }
    const src = [];
    const dst = [];
    for (let j = 0; j <= nv; j += 1) {
      for (let i = 0; i <= nu; i += 1) {
        const u = (wA * i) / nu, v = (hA * j) / nv;
        src.push([u, v]);
        dst.push(at(u, v));
      }
    }
    const cb = freshContext(scratch.b, wB, hB);
    cb.globalCompositeOperation = 'copy';
    cb.imageSmoothingEnabled = true;
    const img = scratch.a;
    const tri = (i0, i1, i2) => {
      const s0 = src[i0], s1 = src[i1], s2 = src[i2];
      const d0 = dst[i0], d1 = dst[i1], d2 = dst[i2];
      const sux = s1[0] - s0[0], suy = s1[1] - s0[1], svx = s2[0] - s0[0], svy = s2[1] - s0[1];
      const det = sux * svy - svx * suy;
      if (Math.abs(det) < 1e-9) return;
      const dux = d1[0] - d0[0], duy = d1[1] - d0[1], dvx = d2[0] - d0[0], dvy = d2[1] - d0[1];
      const a = (dux * svy - dvx * suy) / det;
      const c = (dvx * sux - dux * svx) / det;
      const b = (duy * svy - dvy * suy) / det;
      const d = (dvy * sux - duy * svx) / det;
      const g = growTriangle([d0, d1, d2], 1);
      cb.save();
      cb.beginPath();
      cb.moveTo(g[0][0], g[0][1]);
      cb.lineTo(g[1][0], g[1][1]);
      cb.lineTo(g[2][0], g[2][1]);
      cb.closePath();
      cb.clip();
      cb.setTransform(a, b, c, d, d0[0] - a * s0[0] - c * s0[1], d0[1] - b * s0[0] - d * s0[1]);
      cb.drawImage(img, 0, 0, wA, hA, 0, 0, wA, hA);
      cb.restore();
    };
    for (let j = 0; j < nv; j += 1) {
      for (let i = 0; i < nu; i += 1) {
        const k = j * (nu + 1) + i;
        tri(k, k + 1, k + nu + 2);
        tri(k, k + nu + 2, k + nu + 1);
      }
    }
    plate.save();
    plate.setTransform(1, 0, 0, 1, 0, 0);
    plate.globalAlpha = 1;
    plate.filter = 'none';
    plate.shadowColor = 'rgba(0,0,0,0)';
    plate.shadowBlur = 0;
    plate.shadowOffsetX = 0;
    plate.shadowOffsetY = 0;
    plate.drawImage(scratch.b, 0, 0, wB, hB, bx0, by0, wB, hB);
    plate.restore();
  }

  function mul(m, n) {
    return [
      m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
      m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
      m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
    ];
  }

  // ── Highlight box ─────────────────────────────────────────────────────────
  // Behind ▸ Revealed: how much of each unit this animator lets through — what an
  // Opacity 0 on the same range leaves visible. Negative amounts reveal fully.
  function revealedOf(amt) {
    const out = new Float32Array(amt.length);
    for (let i = 0; i < amt.length; i += 1) out[i] = Number.isNaN(amt[i]) ? NaN : 1 - clamp(amt[i], 0, 1);
    return out;
  }
  // Box geometry, one source for the lab, the app's Player and the preset tiles.
  // Each lays the text out its own way and hands over one cell per unit, aligned
  // with `amt`:  { row, x, w, ink, top, bottom }
  //   x, w         the unit's left edge and width along its row
  //   ink          its width without trailing white space (a finished bar ends at ink)
  //   top, bottom  its line band, before padding
  // Returns rounded rects [{ x0, y0, x1, y1, r, alpha }] to fill in v.color.
  //
  // Grow: each end of a run gives back what its units are NOT selected, as a share
  // of the run's peak, summed over every partly selected unit — so a ramp moves the
  // edge as smoothly as its amounts move (one end unit's share alone steps a whole
  // unit at a time). A growing end runs through the unit's full advance, so the bar
  // crosses a space or a gap instead of stalling in front of it.
  // Block: one shape around every run. A row eases in by how far its run has grown
  // (up to one line height, or the row's own width when shorter) times its peak
  // against the block's, so the shape grows a line taller smoothly, never snapping.
  const BOX_MIN = 1e-4;
  function boxRects(v, amt, cells, groups = null) {
    const n = Math.min(amt.length, cells.length);
    const sel = (k) => amt[k] > BOX_MIN;
    if (v.shape === 'unit') {
      // Per unit: a bar behind each selected unit of the animator's Based on (cells of
      // one group in a row join: the letters of a word), to its ink, as bright as the
      // unit's amount — Text Animation's highlight bar. Spaces have no ink, no bar.
      const opacity = v.opacity / 100;
      const out = [];
      let k = 0;
      while (k < n) {
        if (!sel(k) || !(cells[k].ink > 0)) { k += 1; continue; }
        const g = groups ? groups[k] : k;
        let j = k;
        let peak = amt[k];
        let last = k;
        while (j + 1 < n && cells[j + 1].row === cells[k].row && groups && g >= 0 && groups[j + 1] === g) {
          j += 1;
          if (cells[j].ink > 0) { last = j; peak = Math.max(peak, amt[j]); }
        }
        const f = cells[k], l = cells[last];
        const x0 = f.x - v.padX, x1 = l.x + l.ink + v.padX, y0 = f.top - v.padY, y1 = f.bottom + v.padY;
        if (x1 - x0 > 0.5 && y1 - y0 > 0.5) {
          out.push({ x0, y0, x1, y1, r: Math.max(0, Math.min(v.radius, (y1 - y0) / 2, (x1 - x0) / 2)), alpha: opacity * clamp(peak, 0, 1) });
        }
        k = j + 1;
      }
      return out;
    }
    const sameRow = (k) => k + 1 < n && cells[k + 1].row === cells[k].row;
    const adv = (k) => (sameRow(k) ? Math.max(0, cells[k + 1].x - cells[k].x) : cells[k].w);
    const runs = [];
    let i = 0;
    while (i < n) {
      if (!sel(i)) { i += 1; continue; }
      let j = i;
      let peak = 0;
      while (j < n && cells[j].row === cells[i].row && sel(j)) { peak = Math.max(peak, amt[j]); j += 1; }
      const last = j - 1;
      const f = cells[i];
      const l = cells[last];
      const share = (k) => (v.grow ? clamp(amt[k] / peak, 0, 1) : 1);
      let x0 = f.x;
      let x1 = l.x + l.ink;
      if (v.grow && i < last) {
        // Both walks stop at a fully selected unit: the run's peak is one.
        const sl = share(last);
        if (sl < 1) {
          x1 = l.x + (sameRow(last) ? adv(last) : l.ink) * sl;
          for (let k = last - 1; k >= i && share(k) < 1; k -= 1) x1 -= (1 - share(k)) * adv(k);
        }
        for (let k = i; k < last && share(k) < 1; k += 1) x0 += (1 - share(k)) * adv(k);
        if (x1 < x0) x1 = x0;
      }
      runs.push({ row: f.row, x0, x1, top: f.top, bottom: f.bottom, peak, covered: x1 - x0 });
      i = j;
    }
    if (!runs.length) return [];
    const opacity = v.opacity / 100;
    const rect = (x0, y0, x1, y1, a) => {
      x0 -= v.padX; x1 += v.padX; y0 -= v.padY; y1 += v.padY;
      if (!(x1 - x0 > 0.5 && y1 - y0 > 0.5) || !(a > 0)) return null;
      return { x0, y0, x1, y1, r: Math.max(0, Math.min(v.radius, (y1 - y0) / 2, (x1 - x0) / 2)), alpha: opacity * clamp(a, 0, 1) };
    };
    if (v.shape !== 'block') return runs.map((q) => rect(q.x0, q.top, q.x1, q.bottom, q.peak)).filter(Boolean);
    // Block: rows first (a row can hold several runs), then the shape.
    const rows = new Map();
    for (const q of runs) {
      const r = rows.get(q.row);
      if (!r) { rows.set(q.row, { ...q }); continue; }
      r.x0 = Math.min(r.x0, q.x0); r.x1 = Math.max(r.x1, q.x1);
      r.top = Math.min(r.top, q.top); r.bottom = Math.max(r.bottom, q.bottom);
      r.peak = Math.max(r.peak, q.peak); r.covered += q.covered;
    }
    // Each row's whole ink width, selected or not: a fixed yardstick, so a unit
    // joining a run never makes the row look less grown.
    const span = new Map();
    for (let k = 0; k < n; k += 1) {
      const c = cells[k];
      const sp = span.get(c.row) || { a: Infinity, b: -Infinity };
      sp.a = Math.min(sp.a, c.x);
      if (c.ink > 0) sp.b = Math.max(sp.b, c.x + c.ink);
      span.set(c.row, sp);
    }
    const list = [...rows.values()];
    const peak = Math.max(...list.map((r) => r.peak));
    for (const r of list) {
      const sp = span.get(r.row);
      const width = sp && sp.b > sp.a ? sp.b - sp.a : 0;
      const grown = v.grow ? clamp(r.covered / Math.max(1e-6, Math.min(width, r.bottom - r.top)), 0, 1) : 1;
      const s = grown * grown * (3 - 2 * grown);
      r.h = s * (peak > 0 ? r.peak / peak : 0);
    }
    // The core = the rows that are fully in, measured against the most grown row:
    // with none fully in yet, two rows level with each other are both core, so the
    // shape never jumps when the lead passes from one row to the next.
    const hMax = Math.max(...list.map((r) => r.h));
    for (const r of list) r.h = hMax > 0 ? r.h / hMax : 1;
    const core = list.filter((r) => r.h >= 1 - 1e-6);
    let x0 = Math.min(...core.map((r) => r.x0));
    let x1 = Math.max(...core.map((r) => r.x1));
    let y0 = Math.min(...core.map((r) => r.top));
    let y1 = Math.max(...core.map((r) => r.bottom));
    const cx0 = x0, cx1 = x1, cy0 = y0, cy1 = y1;
    for (const r of list) {
      if (core.includes(r)) continue;
      x0 = Math.min(x0, lerp(cx0, r.x0, r.h)); x1 = Math.max(x1, lerp(cx1, r.x1, r.h));
      y0 = Math.min(y0, lerp(cy0, r.top, r.h)); y1 = Math.max(y1, lerp(cy1, r.bottom, r.h));
    }
    const one = rect(x0, y0, x1, y1, peak);
    return one ? [one] : [];
  }

  // ── Caret ─────────────────────────────────────────────────────────────────
  // Where a Caret effect paints at `time` (cells as boxRects): { x, y, w, h, alpha,
  // color } — color null = the text colour — or null. The front = how much of the text
  // this animator lets through, summed in flow order, so the caret glides with the
  // typing. Solid while typing, blinking before and after (the phase restarts when
  // the typing ends, so it never blinks off the instant the last letter lands), gone
  // once a unit starts to leave or Hide after the typing ends. The box sits on the
  // cell's band (the font size).
  function caretRect(c, cells, time) {
    const { v, amt } = c;
    const n = Math.min(amt.length, cells.length);
    if (!n || time >= c.outStart) return null;
    let f = 0;
    for (let k = 0; k < n; k += 1) f += Number.isNaN(amt[k]) ? 0 : clamp(amt[k], 0, 1);
    const done = f >= n - 1e-3;
    const typing = f > 1e-3 && !done;
    const end = Number.isFinite(c.inEnd) ? c.inEnd : null;
    if (v.hide && done && (end === null || time >= end + v.hideAfter)) return null;
    if (!typing && v.blink > 0) {
      const t0 = done && end !== null && time >= end ? end : 0;
      if (Math.floor((time - t0) * v.blink * 2) % 2 !== 0) return null;
    }
    let cell, x;
    if (done) {
      let k = n - 1;
      while (k > 0 && !(cells[k].ink > 0)) k -= 1;
      cell = cells[k];
      x = cell.x + cell.ink;
    } else {
      const k = Math.min(n - 1, Math.floor(f));
      cell = cells[k];
      const adv = k + 1 < n && cells[k + 1].row === cell.row ? Math.max(0, cells[k + 1].x - cell.x) : cell.w;
      x = cell.x + (f - k) * adv;
    }
    const fs = Math.max(1, cell.bottom - cell.top);
    const y = cell.top;
    const w = v.width > 0 ? v.width : null;
    const color = v.ownColor ? v.color : null;
    if (v.style === 'underscore') return { x: x + fs * 0.03, y: y + fs * 0.98, w: w ?? fs * 0.52, h: Math.max(2, fs * 0.075), alpha: 1, color };
    if (v.style === 'block') return { x: x + fs * 0.02, y: y - fs * 0.02, w: w ?? fs * 0.56, h: fs * 1.12, alpha: 0.85, color };
    return { x: x + fs * 0.04, y: y - fs * 0.02, w: w ?? Math.max(2, fs * 0.07), h: fs * 1.12, alpha: 1, color };
  }

  // ── Motion (the app's cached text plate) ──────────────────────────────────
  // What a stack's look depends on in time: the time itself while something moves; a
  // token that changes only when a Time / Voice animator passes from one resting state
  // to the next; null when nothing ever moves. hasTrack(aid) = it has keyframes.
  //   ctx: as driveAmounts (time, clipSec, units, counts, voice)
  function motionKey(animators, hasTrack, ctx) {
    const t = Number(ctx.time) || 0;
    let key = null;
    for (const an of animators || []) {
      if (!an || an.enabled === false || !an.effects?.some((e) => e && e.enabled !== false)) continue;
      const on = an.effects.filter((e) => e && e.enabled !== false);
      if (on.some((e) => (e.type === 'caret' && e.blink > 0) || (e.type === 'scramble' && e.rate > 0))) return t;
      if (an.wiggle?.enabled && an.wiggle.rate > 0) return t;
      if (hasTrack && hasTrack(an.aid)) return t;
      const r = an.range || {};
      if (r.drive === 'time' || r.drive === 'voice') {
        const res = driveAmounts(r, (ctx.counts && ctx.counts[r.basedOn]) || 0, ctx);
        let phase = '';
        for (const [a, b] of res.spans) {
          if (t >= a && t <= b) return t;
          phase += t > b ? '1' : '0';
        }
        key = `${key || 'rest:'}${phase};`;
      } else if (r.flow) return t;
    }
    return key;
  }

  const api = {
    RANGE_FIELDS, WIGGLE_FIELDS, LAYER_FIELDS, LAYER_ITEM_KEYS, EFFECTS, EFFECT_BY_KEY, EFFECT_GROUPS, CHARSETS,
    MAX_ANIMATORS, MAX_EFFECTS, EASE, KF_PREFIX,
    defaultsOf, sanitizeAnimators, sanitizeAnimator, sanitizeItemFields, layerSettings, newAnimator, newEffect,
    liveAnimators, grainOf, needsLayout, animatorsMove,
    trackKey, parseTrackKey, channelInfo, trackLabel, buildKfProps,
    evalTrack, evaluate, selection, rangeEdges, mapToUnits, glyphFor, mul, revealedOf, boxRects,
    LEVELS, levelOf, hasTransform, groupBoxes, maskedXf, unitTransform, unitTransform3d, m4Mul, applyH, hToCanvas, warpBegin, warpEnd,
    hexToRgb, rgbCss, mixRgb, sampleStops, paintCss, easeShape, shapeAt,
    CURVE_NAMES, RANGE_ONLY, DRIVE_ONLY, rangeShows, fieldShown, curveFn, ranksOf, voiceFits, voiceTurns, driveAmounts, rangeAt,
    caretRect, motionKey,
  };
  return api;
})();

export const {
  RANGE_FIELDS,
  WIGGLE_FIELDS,
  LAYER_FIELDS,
  LAYER_ITEM_KEYS,
  EFFECTS,
  EFFECT_BY_KEY,
  EFFECT_GROUPS,
  CHARSETS,
  MAX_ANIMATORS,
  MAX_EFFECTS,
  EASE,
  KF_PREFIX,
  defaultsOf,
  sanitizeAnimators,
  sanitizeAnimator,
  sanitizeItemFields,
  layerSettings,
  newAnimator,
  newEffect,
  liveAnimators,
  grainOf,
  needsLayout,
  animatorsMove,
  trackKey,
  parseTrackKey,
  channelInfo,
  trackLabel,
  buildKfProps,
  evalTrack,
  evaluate,
  selection,
  rangeEdges,
  mapToUnits,
  glyphFor,
  mul,
  revealedOf,
  boxRects,
  LEVELS,
  levelOf,
  hasTransform,
  groupBoxes,
  maskedXf,
  unitTransform,
  unitTransform3d,
  m4Mul,
  applyH,
  hToCanvas,
  warpBegin,
  warpEnd,
  hexToRgb,
  rgbCss,
  mixRgb,
  sampleStops,
  paintCss,
  easeShape,
  shapeAt,
  CURVE_NAMES,
  RANGE_ONLY,
  DRIVE_ONLY,
  rangeShows,
  fieldShown,
  curveFn,
  ranksOf,
  voiceFits,
  voiceTurns,
  driveAmounts,
  rangeAt,
  caretRect,
  motionKey,
} = TXA;
export default TXA;
