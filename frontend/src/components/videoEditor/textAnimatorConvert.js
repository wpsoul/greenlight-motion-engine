// GENERATED from html/finished/text-animators-lab/convert.js by tests/text-animators/port_from_lab.mjs.
// Do not edit here: change the lab converter, then run  node tests/text-animators/port_from_lab.mjs
import TXA from './textAnimators.js';
import TXA_PRESETS from './textAnimatorPresets.js';

const factory = function (T, P) {
  // Text Animation stores split easings as TransitionEasing KEYS ('EXPO_OUT');
  // animators store the display names ('Expo Out').
  const EASE_NAME = {
    LINEAR: 'Linear', EASE_IN: 'Ease In', EASE_OUT: 'Ease Out', EASE_IN_OUT: 'Smooth',
    AE_IN: 'AE In', AE_SMOOTH: 'AE Smooth', AE_OUT: 'AE Out',
    SINE_IN: 'Sine In', SINE_OUT: 'Sine Out', SINE_IN_OUT: 'Sine Smooth',
    CUBIC_IN_OUT: 'Cubic Smooth', CUBIC_IN: 'Cubic In', CUBIC_OUT: 'Cubic Out',
    EXPO_IN: 'Expo In', EXPO_OUT: 'Expo Out', EXPO_IN_OUT: 'Expo Smooth',
    CIRC_IN: 'Circ In', CIRC_OUT: 'Circ Out', CIRC_IN_OUT: 'Circ Smooth',
    BACK_IN: 'Back In', BACK_OUT: 'Back Out', BACK_IN_OUT: 'Back Smooth',
    BOUNCE_OUT: 'Bounce Out', ELASTIC_OUT: 'Elastic',
    NATURAL: 'Natural', SLOW_DOWN: 'Slow Down', OVERSHOOT: 'Overshoot', IMPULSE: 'Impulse', SWING: 'Swing',
    SMOOTH_OVERSHOOT: 'Smooth Overshoot',
    POWER1_IN: 'Power1 In', POWER1_OUT: 'Power1 Out', POWER1_IN_OUT: 'Power1 Smooth',
    POWER2_IN: 'Power2 In', POWER2_OUT: 'Power2 Out', POWER2_IN_OUT: 'Power2 Smooth',
    POWER3_IN: 'Power3 In', POWER3_OUT: 'Power3 Out', POWER3_IN_OUT: 'Power3 Smooth',
    POWER4_IN: 'Power4 In', POWER4_OUT: 'Power4 Out', POWER4_IN_OUT: 'Power4 Smooth',
  };
  const curveOf = (v, fallback) => {
    const n = EASE_NAME[v] || v;
    return T.CURVE_NAMES.includes(n) ? n : fallback;
  };
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const numOr = (v, d) => {
    const n = Number(v);
    return v !== null && v !== undefined && v !== '' && Number.isFinite(n) ? n : d;
  };
  const HEX = /^#[0-9a-f]{6}$/i;
  // One CSS colour → #rrggbb: #rgb, #rgba, #rrggbb, #rrggbbaa, rgb() / rgba() (alpha
  // dropped); null for anything else (names, gradients).
  const hex2 = (n) => Math.round(clamp(n, 0, 255)).toString(16).padStart(2, '0');
  const hexOf = (v) => {
    if (typeof v !== 'string') return null;
    const s = v.trim().toLowerCase();
    let m = /^#([0-9a-f]{3,4})$/.exec(s);
    if (m) return `#${m[1].slice(0, 3).split('').map((c) => c + c).join('')}`;
    m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(s);
    if (m) return `#${m[1]}`;
    m = /^rgba?\(\s*([\d.]+%?)[\s,]+([\d.]+%?)[\s,]+([\d.]+%?)/.exec(s);
    if (m) {
      const ch = (t) => (t.endsWith('%') ? (parseFloat(t) * 255) / 100 : parseFloat(t));
      return `#${hex2(ch(m[1]))}${hex2(ch(m[2]))}${hex2(ch(m[3]))}`;
    }
    return null;
  };
  // A CSS gradient's colour stops (2–6, as #rrggbb) and its angle; null if not one.
  const gradientOf = (v) => {
    if (typeof v !== 'string' || !/gradient\(/i.test(v)) return null;
    const colors = (v.match(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/gi) || []).map(hexOf).filter(Boolean).slice(0, 6);
    if (colors.length < 2) return null;
    const a = /(-?[\d.]+)deg/i.exec(v);
    const to = /to (right|left|top|bottom)\b/i.exec(v);
    const css = a ? parseFloat(a[1]) : to ? { top: 0, right: 90, bottom: 180, left: 270 }[to[1].toLowerCase()] : 180;
    // CSS 0deg points up, the effect's 0° runs left → right: CSS 90deg = 0°.
    return { colors, angle: Math.round((((css - 90) % 360) + 360) % 360) };
  };
  // A highlight colour may be a CSS gradient: its first stop stands in.
  const solidOf = (v, d) => {
    const h = hexOf(v);
    if (h) return h;
    const g = gradientOf(v);
    return g ? g.colors[0] : d;
  };
  // Split mode → Based on. 'symbols' tokens include the spaces (Characters).
  const BASED = { symbols: 'chars', words: 'words', lines: 'lines' };
  // A highlight's own unit: 'symbols' counts letters only.
  const HL_BASED = { symbols: 'charsNoSpace', words: 'words', lines: 'lines' };

  // One side of the split (In or Out) as animator effects, Player.jsx's defaults.
  //   flat  Rotate X / Y as Text Animation drew them: flat (Perspective 0)
  function sideEffects(f, side, mask, lineEm, flat) {
    const g = (k, d) => numOr(f[`split${side}${k}`], d);
    const isIn = side === 'In';
    const out = [];
    const x = g('X', 0);
    const y = g('Y', isIn ? 40 : -40);
    const scale = g('Scale', 1);
    const rot = g('Rotate', 0);
    const rx = g('RotateX', 0);
    const ry = g('RotateY', 0);
    const blur = g('Blur', 0);
    const opacity = clamp(g('Opacity', 0), 0, 1);
    // Masked, the split moves every unit at least one line (In from below, Out
    // upwards, unless its Y says otherwise) so it fully hides behind its box edge —
    // an x-only slide rises too. Same here.
    if (mask) out.push(['position', { x, y: { px: y, minEm: isIn ? lineEm : -lineEm } }]);
    else if (x || y) out.push(['position', { x, y }]);
    if (scale !== 1) out.push(['scale', { scale: Math.round(scale * 10000) / 100 }]);
    if (rot) out.push(['rotation', { angle: rot }]);
    if (rx || ry) out.push(['rotate3d', { x: rx, y: ry, ...(flat ? { perspective: 0 } : null) }]);
    if (blur > 0) out.push(['blur', { amount: blur }]);
    if (opacity < 1) out.push(['opacity', { opacity: Math.round(opacity * 100) }]);
    return out;
  }

  // A keyframed highlight colour keeps its first key (animator colours have no keys).
  function highlightColorOf(f) {
    const track = f.propertyKeyframes && f.propertyKeyframes.textHighlightColor;
    if (Array.isArray(track) && track.length) {
      const first = [...track].sort((a, b) => a.position - b.position)[0];
      if (typeof first.value === 'string' && first.value.trim()) return first.value;
    }
    return f.textHighlightColor;
  }

  function highlightEffects(f) {
    const style = ['text', 'background', 'text-glow', 'glow'].includes(f.textHighlightStyle) ? f.textHighlightStyle : 'background';
    const raw = highlightColorOf(f);
    const color = solidOf(raw, '#ffe74c');
    const glow = clamp(numOr(f.textHighlightGlow, 0), 0, 100);
    const spacing = clamp(numOr(f.textHighlightSpacing, 0), 0, 120);
    const grad = style === 'text' && !hexOf(raw) ? gradientOf(raw) : null;
    if (grad) return [['gradient', { colors: grad.colors, angle: grad.angle, span: 'text' }]];
    if (style === 'text') return [['fill', { color }]];
    if (style === 'glow') return [['glow', { color, size: glow, strength: 100 }]];
    if (style === 'text-glow') return [['fill', { color }], ['glow', { color, size: glow, strength: 100 }]];
    // The split's bar: one per unit, its box + spacing all round, corners spacing + 0.14 em.
    // Fade with text: the split dimmed a bar with its unit's reveal.
    return [['box', { color, padX: spacing, padY: spacing, radius: { px: spacing, em: 0.14 }, grow: false, behind: 'selected', shape: 'unit', opacity: 100, withText: true }]];
  }

  function caretEffect(f) {
    const color = hexOf(f.textCaretColor);
    const hideAfter = f.textCaretHideAfter;
    const hides = hideAfter !== null && hideAfter !== undefined && Number.isFinite(Number(hideAfter));
    return ['caret', {
      style: ['bar', 'underscore', 'block'].includes(f.textCaretStyle) ? f.textCaretStyle : 'bar',
      ownColor: !!color,
      ...(color ? { color } : null),
      width: clamp(numOr(f.textCaretWidth, 0), 0, 80),
      blink: clamp(numOr(f.textCaretBlink, 1.1), 0, 10),
      hide: hides,
      hideAfter: hides ? clamp(Number(hideAfter), 0, 600) : 0,
    }];
  }

  // Does the item's text have one stored word timing per word (Player's wordWinSec
  // rule)? Without it Text Animation's transcript clocks fall back.
  const timingsFit = (f) => {
    const n = (String(f.textContent || '').match(/\S+/g) || []).length;
    return Array.isArray(f.textWordTimings) && n > 0 && f.textWordTimings.length === n;
  };

  // Regular fields → a presets.js preset (+ notes on what could not carry over).
  //   opts.id / name / cat / description   for the preset
  //   opts.layer  convert a real layer (not a catalogue preset): Rotate X / Y stay
  //               flat, and the layer's own gates apply — no highlight on clip-mask
  //               text, no caret on clip-mask or path text, a Voice highlight whose
  //               timings no longer fit the text rides the In clock, and Timing ▸
  //               Keyframes keeps its Reveal track (the In animator's Start)
  function fromItem(f, opts = {}) {
    const notes = [];
    const animators = [];
    if (!f || !f.textSplitEnabled) return { preset: null, notes: ['Text Animation is off on this layer'] };
    const layer = !!opts.layer;
    const mode = f.textSplitMode === 'lines' || f.textSplitMode === 'symbols' ? f.textSplitMode : 'words';
    const basedOn = BASED[mode];
    const stagger = clamp(numOr(f.textSplitStagger, 0) || 0, 0, 1);
    const mask = f.textSplitMask === 'lines' || f.textSplitMask === 'words' || f.textSplitMask === 'symbols';
    const lineEm = clamp(numOr(f.textLineHeight, 1.15) || 1.15, 0.7, 3);
    const voice = f.textSplitTiming === 'transcript';
    const revealTrack = f.textSplitTiming === 'progress' && f.propertyKeyframes && Array.isArray(f.propertyKeyframes.textRevealProgress) && f.propertyKeyframes.textRevealProgress.length
      ? [...f.propertyKeyframes.textRevealProgress].sort((a, b) => a.position - b.position)
      : null;
    if (f.textSplitTiming === 'progress' && !(layer && revealTrack)) notes.push('Typing by keyframes runs on the stagger (Time) here');
    const drive = voice ? 'voice' : 'time';
    const inOn = !!f.splitInEnabled;
    const outOn = !!f.splitOutEnabled;
    const isClipMask = !!f.textClipMask;
    const onPath = !!f.textPathEnabled;
    const base = { basedOn, order: 'forward', stagger, mask, spread: false };
    let inAn = null;
    if (inOn) {
      const effects = sideEffects(f, 'In', mask, lineEm, layer);
      inAn = layer && revealTrack
        // Timing ▸ Keyframes: the Reveal % IS the range Start — a unit is selected
        // by how much of it the front has not passed yet (Square, one-unit edge),
        // exactly the split's per-unit progress.
        ? { name: 'In', range: { basedOn, mask, drive: 'range', units: 'percent', start: 0, end: 100, shape: 'square', smooth: 100 }, effects,
          keys: { start: revealTrack.map((k) => [clamp(numOr(k.position, 0), 0, 100), clamp(numOr(k.value, 100), 0, 100), k.easing || 'Linear']) } }
        : {
          name: 'In',
          range: { ...base, drive, animate: 'in', duration: clamp(numOr(f.splitInDuration, 0) || 0.4, 0.05, 4), curve: curveOf(f.splitInEasing || 'EASE_OUT', 'Ease Out') },
          effects,
        };
      animators.push(inAn);
    }
    if (outOn) {
      animators.push({
        name: 'Out',
        range: { ...base, drive: 'time', animate: 'out', duration: clamp(numOr(f.splitOutDuration, 0) || 0.4, 0.05, 4), curve: curveOf(f.splitOutEasing || 'EASE_IN', 'Ease In') },
        effects: sideEffects(f, 'Out', mask, lineEm, layer),
      });
    }
    if (f.textHighlightEnabled && layer && isClipMask) notes.push('A clip-mask text draws no highlight: not converted');
    else if (f.textHighlightEnabled) {
      const act = f.textHighlightActivation;
      const own = act === 'own';
      // A layer whose timings no longer fit its words lights them on the In clock.
      const spoken = act === 'transcript' && !(layer && !timingsFit(f));
      if (!own && !spoken && !inOn) {
        notes.push('The highlight follows the In animation, which is off: nothing to convert');
      } else {
        const range = {
          drive: spoken ? 'voice' : 'time', animate: 'active', order: 'forward', curve: 'Linear',
          delay: clamp(numOr(f.textHighlightDelay, 0), 0, 10),
          fadeOut: clamp(numOr(f.textHighlightFadeOut, 0), 0, 5),
          keepLast: !!f.textHighlightKeepLast,
        };
        if (own) {
          const hm = ['words', 'lines', 'symbols'].includes(f.textHighlightMode) ? f.textHighlightMode : 'words';
          Object.assign(range, {
            basedOn: HL_BASED[hm],
            stagger: clamp(numOr(f.textHighlightStagger, 0) || 0.35, 0.05, 5),
            duration: clamp(numOr(f.textHighlightFadeIn, 0), 0, 2),
            hold: clamp(numOr(f.textHighlightHold, 0), 0, 10),
            loop: !!f.textHighlightLoop,
          });
        } else if (spoken) {
          // Without timings the split's highlight rides the In clock: so does this.
          Object.assign(range, {
            basedOn: 'words', spread: false, stagger: Math.max(stagger, 0.0001),
            duration: clamp(numOr(f.textHighlightFadeIn, 0), 0, 2),
            hold: clamp(numOr(f.textHighlightHold, 0), 0, 10),
          });
        } else {
          // Sync: one step per split stagger, hard on, lit for one step.
          Object.assign(range, { basedOn, stagger: Math.max(stagger, 0.0001), duration: 0, hold: 0 });
        }
        animators.push({ name: 'Highlight', range, effects: highlightEffects(f) });
      }
    }
    if (f.textCaretEnabled && layer && (isClipMask || onPath)) notes.push('A clip-mask or path text draws no caret: not converted');
    else if (f.textCaretEnabled) {
      if (inAn) inAn.effects.push(caretEffect(f));
      else {
        // No In: the text is all there, so the caret sits at its end and blinks.
        animators.push({ name: 'Caret', range: { basedOn, drive: 'time', animate: 'in', stagger: 0, duration: 0 }, effects: [caretEffect(f)] });
      }
    }
    if (!animators.length) return { preset: null, notes: notes.length ? notes : ['Nothing to convert: In, Out, Highlight and Caret are off'] };
    return {
      preset: {
        id: opts.id || 'converted',
        name: opts.name || 'Converted',
        cat: opts.cat || 'classic',
        description: opts.description || '',
        sides: outOn && inOn ? 'inOut' : outOn ? 'out' : inOn ? 'in' : 'loop',
        // The Reveal keys sit at % of the layer, like the track they came from.
        anchor: inAn && inAn.keys ? 'clip' : 'drive',
        animators,
      },
      notes,
    };
  }

  // ── Stored layers: Text Animation → animators, once ──────────────────────────
  // Every Text Animation field and track. A migrated item keeps none of them: a
  // value without a control would be invisible and could never be cleared.
  const LEGACY_KEY = /^(textSplit|split(In|Out)[A-Z]|textHighlight|textCaret)/;
  const LEGACY_TRACKS = ['textRevealProgress', 'textHighlightColor'];

  // Split units in the text, as the Player counted them (an empty line is one).
  function splitUnitCount(text, mode) {
    const lines = String(text || '').replace(/\r/g, '').split('\n');
    if (mode === 'lines') return lines.length;
    let n = 0;
    for (const line of lines) {
      if (!line.trim()) n += 1;
      else n += mode === 'symbols' ? Array.from(line).length : (line.match(/\S+\s*/g) || [line]).length;
    }
    return n;
  }

  // With the split on (Timing ≠ Keyframes), the layer's own keyframes played per unit:
  // unit i ran the whole keyframe timeline at progress p·K − S·i (K = 1 + S·(n − 1),
  // S = the stagger read as a fraction of the layer), and the layer itself ignored
  // them. These channels did that; a two-key track whose one end is the rest value
  // becomes a Time animator with the same per-unit timing. The rest (more keys, both
  // ends away from rest, other channels) stays on the layer as a whole.
  const UNIT_TRACKS = {
    scale: { type: 'scale', rest: 1, of: (v) => ({ scale: Math.round(v * 10000) / 100 }) },
    rotate: { type: 'rotation', rest: 0, of: (v) => ({ angle: v }) },
    translateX: { type: 'position', rest: 0, of: (v) => ({ x: v, y: 0 }) },
    translateY: { type: 'position', rest: 0, of: (v) => ({ x: 0, y: v }) },
    opacity: { type: 'opacity', rest: 1, of: (v) => ({ opacity: Math.round(clamp(v, 0, 1) * 100) }) },
  };
  function unitKeyframeAnimators(f, clipSec) {
    const pk = f.propertyKeyframes || {};
    const mode = f.textSplitMode === 'lines' || f.textSplitMode === 'symbols' ? f.textSplitMode : 'words';
    const n = Math.max(1, splitUnitCount(f.textContent, mode));
    const S = clamp(numOr(f.textSplitStagger, 0) || 0, 0, 1);
    const K = 1 + S * (n - 1);
    const D = Math.max(0.001, clipSec);
    const animators = [];
    const used = [];
    const notes = [];
    for (const [key, spec] of Object.entries(UNIT_TRACKS)) {
      const track = pk[key];
      if (!Array.isArray(track) || !track.length) continue;
      const [a, b] = [...track].sort((x, y) => x.position - y.position);
      const v0 = Number.parseFloat(a && a.value);
      const v1 = Number.parseFloat(b && b.value);
      const atRest = (v) => Math.abs(v - spec.rest) < 1e-6;
      if (track.length !== 2 || !Number.isFinite(v0) || !Number.isFinite(v1) || (!atRest(v0) && !atRest(v1)) || atRest(v0) === atRest(v1)) {
        notes.push(`The ${key} keyframes now move the whole layer`);
        continue;
      }
      const p0 = clamp(numOr(a.position, 0), 0, 100) / 100;
      const p1 = clamp(numOr(b.position, 100), 0, 100) / 100;
      const arriving = atRest(v1);
      animators.push({
        name: `Per unit ${key}`,
        range: {
          basedOn: BASED[mode], drive: 'time', animate: arriving ? 'in' : 'out', order: 'forward',
          // In: unit i starts at D(p0 + S·i)/K. Out: the last unit ends D(1 − p1)/K
          // before the layer does.
          delay: arriving ? (D * p0) / K : (D * (1 - p1)) / K,
          stagger: (D * S) / K,
          duration: Math.max(0, (D * (p1 - p0)) / K),
          curve: curveOf(a.easing || 'Linear', 'Smooth'),
        },
        effects: [[spec.type, spec.of(arriving ? v0 : v1)]],
      });
      used.push(key);
    }
    return { animators, used, notes };
  }

  // One stored text item → { item, notes, changed }. Text Animation becomes animators
  // placed BEFORE the layer's own (the split ran first); Split By, which also laid the
  // text out, becomes the wrap (Lines never wrapped, Symbols broke anywhere).
  //   clipSec  the layer's timeline length; fontPx its font size in composition px
  function migrateItem(item, { clipSec = 4, fontPx = 100 } = {}) {
    if (!item || typeof item !== 'object') return { item, notes: [], changed: false };
    const notes = [];
    const out = {};
    let changed = false;
    for (const [k, v] of Object.entries(item)) {
      if (LEGACY_KEY.test(k)) changed = true;
      else out[k] = v;
    }
    const srcPk = item.propertyKeyframes && typeof item.propertyKeyframes === 'object' ? item.propertyKeyframes : null;
    const pk = srcPk ? { ...srcPk } : {};
    for (const k of LEGACY_TRACKS) if (k in pk) { delete pk[k]; changed = true; }
    if (item.textSplitMode === 'lines' && !item.textNoWrap) out.textNoWrap = true;
    else if (item.textSplitMode === 'symbols' && !item.textNoWrap) out.textWrapAnywhere = true;
    let preset = null;
    if (item.textSplitEnabled) {
      const r = fromItem(item, { layer: true });
      if (r.preset) preset = r.preset;
      else if (item.splitInEnabled || item.splitOutEnabled || item.textHighlightEnabled || item.textCaretEnabled) notes.push(...r.notes);
      for (const n of r.preset ? r.notes : []) notes.push(n);
      const ownsKeys = item.textSplitTiming !== 'progress' && srcPk
        && Object.keys(srcPk).some((k) => Array.isArray(srcPk[k]) && srcPk[k].length && !k.startsWith(T.KF_PREFIX));
      if (ownsKeys) {
        const u = unitKeyframeAnimators(item, clipSec);
        notes.push(...u.notes);
        for (const k of u.used) delete pk[k];
        if (u.animators.length) {
          preset = preset
            ? { ...preset, animators: [...preset.animators, ...u.animators] }
            : { id: 'converted', name: 'Converted', cat: 'classic', description: '', sides: 'in', anchor: 'drive', animators: u.animators };
        }
      }
    }
    if (preset) {
      const existing = Array.isArray(item.textAnimators) ? item.textAnimators : [];
      const used = new Set(existing.flatMap((a) => [a.aid, ...(a.effects || []).map((e) => e.pid)]));
      const built = P.build(preset, { clipSec, fontPx, used });
      const names = new Set(existing.map((a) => a.name));
      const mine = built.animators.map((a) => {
        let name = a.name;
        for (let i = 2; names.has(name); i += 1) name = `${a.name} ${i}`;
        names.add(name);
        return { ...a, name };
      });
      out.textAnimators = [...mine, ...existing].slice(0, T.MAX_ANIMATORS);
      if (existing.length + mine.length > T.MAX_ANIMATORS) notes.push(`Only ${T.MAX_ANIMATORS} animators fit: the last ones were dropped`);
      Object.assign(pk, built.tracks);
      // The Reveal track itself, key for key (custom curves and slices included).
      const ri = preset.animators.findIndex((a) => a.keys && a.keys.start);
      if (ri >= 0 && srcPk && Array.isArray(srcPk.textRevealProgress)) {
        pk[T.trackKey(mine[ri].aid, 'start')] = srcPk.textRevealProgress.map((k) => ({ ...k }));
      }
      changed = true;
    }
    if (srcPk || Object.keys(pk).length) out.propertyKeyframes = pk;
    if (out.textNoWrap !== item.textNoWrap || out.textWrapAnywhere !== item.textWrapAnywhere) changed = true;
    return { item: changed ? out : item, notes, changed };
  }

  // Regular preset props that are not the animation itself (caption bar, border,
  // Randomizer, shadow, size): an Advanced copy writes them too, so it looks the same.
  const ANIMATION_KEY = /^(split(In|Out)|textSplit|textHighlight|textCaret)/;
  // Every regular preset (EditorPanel TEXT_ANIM_PRESETS: { id, name, cat,
  // description, props }) as an Advanced preset, in "Classic · <category>" groups.
  function classicPresets(list, categories) {
    const catName = Object.fromEntries((categories || []).map((c) => [c.id, c.name]));
    const presets = [];
    for (const p of list || []) {
      if (!p || !p.props) continue;
      const { preset } = fromItem({ textSplitEnabled: true, ...p.props }, {
        id: `classic-${p.id}`, name: p.name, cat: `classic-${p.cat}`, description: p.description,
      });
      if (!preset) continue;
      const extra = {};
      for (const [k, v] of Object.entries(p.props)) if (!ANIMATION_KEY.test(k)) extra[k] = v;
      presets.push({ ...preset, classicOf: p.id, ...(Object.keys(extra).length ? { layerProps: extra } : null) });
    }
    // Grouped by the regular catalogue's category order (its list interleaves them).
    const order = (categories || []).map((c) => `classic-${c.id}`);
    const rank = (cat) => (order.includes(cat) ? order.indexOf(cat) : order.length);
    const sorted = presets.map((p, i) => ({ p, i })).sort((a, b) => rank(a.p.cat) - rank(b.p.cat) || a.i - b.i).map((x) => x.p);
    const seen = [];
    for (const p of sorted) if (!seen.includes(p.cat)) seen.push(p.cat);
    return {
      categories: seen.map((id) => ({ id, name: `Classic · ${catName[id.slice(8)] || id.slice(8)}` })),
      presets: sorted,
    };
  }

  const api = { EASE_NAME, curveOf, fromItem, classicPresets, migrateItem, splitUnitCount, LEGACY_KEY, LEGACY_TRACKS };
  return api;
};

const CONVERT_API = factory(TXA, TXA_PRESETS);
export const {
  EASE_NAME,
  curveOf,
  fromItem,
  classicPresets,
  migrateItem,
  splitUnitCount,
  LEGACY_KEY,
  LEGACY_TRACKS,
} = CONVERT_API;
export default CONVERT_API;
