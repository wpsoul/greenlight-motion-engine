// Card Fan (MotionFast `card-fan-cycle`): 3–7 rounded cards ride a big wheel pivoted off the left edge. One motion curve
// (a soft + a sharp sigmoid) moves every card one 15° slot down while the fan briefly spreads, then the move mirrors
// back; a new card fades in at the top, the bottom one slides out. Soft seam shadows fall from each card onto the one
// above it.
//
// Built from ordinary layers: per card its plate (a rounded shape in its colour) and, with media, its picture (fitted
// cover / contain / stretch and scaled inside the card); per seam the two shadows MotionFast casts (a soft one and an
// edge line: pre-blurred card shapes, here the same blur baked into a picture) clipped to the card they fall on by a
// layer mask that follows that card. Every value is a ƒx of time, MotionFast's curve verbatim (the sigmoids are
// exponentials), so nothing is sampled; the paint order never changes (the fan keeps its angular order), so the
// channels are it.
//
// A built-in script (PLANS/ESSENTIAL_TEMPLATES.md §14): it imports nothing, so this same text also runs as a
// `kind: "script"` source. Numbers and timing are MotionFast's (motionTemplates/cardFanCycle.js).
const CARD_W = 412.8;
const CARD_H = 264;
const CARD_R = 11;
const RADIUS = 939.05;
const STEP_ANGLE = 15;
const MAX_DELTA_DEG = 16.69;
const PIVOT_X = -525.35;
const PHASE_SEC = 2.5;
const DEG = Math.PI / 180;
const BASE_COLORS = ['#f9492d', '#1d9bf1', '#ffffff', '#33efab', '#f9492d', '#ffffff', '#1d9bf1'];
const ENTRY_COLOR = '#ffffff';
// the seam shadows: [blur (stage px), alpha, shift (share of the card's height)]
const TILES = [['soft', 38, 0.42, 1 / 6], ['edge', 22, 0.29, 1 / 14]];

const fields = [
  { type: 'group', key: 'gMedia', label: 'Media' },
  { key: 'media', type: 'media', label: 'Images / videos (fill from center)', slots: { from: 'media', max: 8 }, accept: 'media', ifFewer: 'reuse' },
  { key: 'fillEmpty', type: 'switch', label: 'Copy media to empty cards', default: true },
  { key: 'imageFit', type: 'select', label: 'Image Fit', default: 'cover', options: [
    { value: 'cover', label: 'Cover (fill card)' }, { value: 'contain', label: 'Contain (fit inside)' }, { value: 'stretch', label: 'Stretch' },
  ] },
  { key: 'imageScale', type: 'range', label: 'Image Scale', default: 1, min: 0.5, max: 2, step: 0.05, suffix: 'x' },
  { type: 'group', key: 'gFan', label: 'Fan' },
  { key: 'cardCount', type: 'select', label: 'Cards in view', default: '7', options: [
    { value: '3', label: '3 cards' }, { value: '4', label: '4 cards' }, { value: '5', label: '5 cards' }, { value: '6', label: '6 cards' }, { value: '7', label: '7 cards' },
  ] },
  { key: 'speed', type: 'range', label: 'Speed', default: 1, min: 0.25, max: 3, step: 0.05 },
];

const r6 = (v) => { const x = Math.round(v * 1e6) / 1e6; return Object.is(x, -0) ? 0 : x; };
const r4 = (v) => Math.round(v * 1e4) / 1e4;
const n = (v) => { const x = Number(v); return Math.abs(x) < 1e-12 ? '0' : String(Number(x.toPrecision(10))); };
const one = (v) => [{ position: 0, value: n(v), easing: 'Linear' }];
const fx = (code) => ({ type: 'custom', params: { code } });
// eight points of a rounded rectangle in the mask's unit box (−0.5 … 0.5), corners rx / ry as shares of its sides
function roundRect8(rx, ry) {
  const K = 0.5522847498307936, kx = K * rx, ky = K * ry;
  const P = (x, y, hi, ho) => ({ x: r4(x), y: r4(y), hIn: { x: r4(hi[0]), y: r4(hi[1]) }, hOut: { x: r4(ho[0]), y: r4(ho[1]) }, manual: true });
  return [
    P(-0.5 + rx, -0.5, [-kx, 0], [0, 0]), P(0.5 - rx, -0.5, [0, 0], [kx, 0]),
    P(0.5, -0.5 + ry, [0, -ky], [0, 0]), P(0.5, 0.5 - ry, [0, 0], [0, ky]),
    P(0.5 - rx, 0.5, [kx, 0], [0, 0]), P(-0.5 + rx, 0.5, [0, 0], [-kx, 0]),
    P(-0.5, 0.5 - ry, [0, ky], [0, 0]), P(-0.5, -0.5 + ry, [0, 0], [0, -ky]),
  ];
}
// images fill from the centre card outward, the fade-in entry card last (MotionFast imageRanks)
function imageRanks(count) {
  const slots = [-1];
  for (let s = 0; s < count; s += 1) slots.push(s);
  const center = (count - 1) / 2;
  const ordered = [...slots].sort((a, b) => (Math.abs(a - center) - Math.abs(b - center)) || (a - b));
  return new Map(ordered.map((slot, r) => [slot, r]));
}

export default {
  id: 'card-fan-cycle',
  name: 'Card Fan',
  category: 'Carousels',
  v: 1,
  fields,
  build({ settings: S, media, frame }) {
    const { W, H } = frame;
    const count = Math.max(3, Math.min(7, Math.round(Number(S.cardCount) || 7)));
    const speed = Math.max(0.05, Number(S.speed) || 1);
    const D = (PHASE_SEC * 2) / speed;
    const span = r4(D);
    const lastSlot = count - 1;
    const maxAngle = (lastSlot * STEP_ANGLE) / 2;
    const frameH = Math.round(2 * RADIUS * Math.sin(maxAngle * DEG) - 54);
    const baseAngle = -maxAngle, pivotY = frameH / 2;
    const sc = H / frameH;                         // frame px per stage px (fitted by height, anchored to the left edge)
    const N = count + 1;
    const OFFSET_STEP = (MAX_DELTA_DEG - STEP_ANGLE) / STEP_ANGLE;
    // MotionFast's curve as expression text. Each layer plays one phase (the second mirrors the first back); its keys
    // hold the phase's share x (0 … 1, straight), main is the sigmoid mix of x, env its spread envelope. MotionFast
    // clamps a card's progress to −0.1 … 1.1; main + offset · env never leaves −0.053 … 1.053 (7 cards, the widest
    // offsets), so the clamp never acts and is left out (the ƒx language caps an expression's size and nesting)
    const sig = (k) => { const raw = (v) => 1 / (1 + Math.exp(-k * (v - 0.5))); return [raw(0), 1 / (raw(1) - raw(0))]; };
    const [a8, b8] = sig(8), [a35, b35] = sig(35);
    const main = `(${n(0.4 * b8)}/(1+exp(4-8*value))+${n(0.6 * b35)}/(1+exp(17.5-35*value))-${n(0.4 * a8 * b8 + 0.6 * a35 * b35)})`;
    const env = `(4*${main}*(1-${main}))`;
    const progOf = (off) => (off === 0 ? main : `(${main}+${n(4 * off)}*${main}*(1-${main}))`);
    const cards = [{ i: 0, startSlot: -1, color: ENTRY_COLOR }];
    for (let s = 0; s < count; s += 1) cards.push({ i: s + 1, startSlot: s, color: BASE_COLORS[s] });
    // per phase: a card's angle (deg), opacity and shadow opacity (null: 1)
    const exprs = (c, ph) => {
      const prog = progOf((c.i - (N - 1) / 2) * OFFSET_STEP);
      const a0 = baseAngle + c.startSlot * STEP_ANGLE;
      const angle = ph === 1 ? `(${n(a0)}+${STEP_ANGLE}*${prog})` : `(${n(a0 + STEP_ANGLE)}-${STEP_ANGLE}*${prog})`;
      let opacity = null, shadowOpacity = null;
      if (c.startSlot === -1) shadowOpacity = opacity = ph === 1 ? `clamp(1.6*${prog},0,1)` : `clamp(1-1.6*${prog},0,1)`;
      else if (c.startSlot === lastSlot) {
        if (ph === 1) shadowOpacity = opacity = `clamp(1-(${prog}-0.7)/0.3,0,1)`;
        else shadowOpacity = `clamp((${prog}-0.3)/0.7,0,1)`;
      }
      return { angle, opacity, shadowOpacity };
    };
    // stage px → the frame (% from its centre); a card's centre on the wheel
    const xPct = (e, extra = '') => `(${n(PIVOT_X)}+${n(RADIUS)}*cos(${e.angle}*${n(DEG)})${extra})*${n((sc * 100) / W)}-50`;
    const yPct = (e, extra = '') => `(${n(pivotY)}+${n(RADIUS)}*sin(${e.angle}*${n(DEG)})${extra})*${n((sc * 100) / H)}-50`;
    // the two phases: [0, D/2] and [D/2, D] (a layer's start rounded down to 1/10000 s; its keys hold x exactly there)
    const half = D / 2, cut = Math.floor(half * 1e4 + 1e-7) / 1e4;
    const PH = [{ ph: 1, fs: 0, span: cut, t0: 0 }, { ph: 2, fs: cut, span: r4(span - cut), t0: half }]
      .map((q) => ({ ...q, keys: [{ position: 0, value: n((q.fs - q.t0) / half), easing: 'Linear' }, { position: 100, value: n((q.fs + q.span - q.t0) / half), easing: 'Linear' }] }));
    // a layer per phase on one track: its tracks hold x, each read by its ƒx (code: phase → { track: code | number })
    const layers = [];
    const twoPhases = (lay, code) => {
      for (const q of PH) {
        const tracks = code(q.ph);
        const propertyKeyframes = {}, propertyKeyframeFx = {};
        for (const [k, v] of Object.entries(tracks)) {
          if (v === null || v === undefined) continue;
          if (typeof v === 'number') { propertyKeyframes[k] = one(v); continue; }
          propertyKeyframes[k] = q.keys;
          propertyKeyframeFx[k] = fx(v);
        }
        layers.push({ ...lay, key: `${lay.key}.p${q.ph}`, track: lay.key, freeStart: q.fs, trimEnd: r6(q.span), propertyKeyframes, propertyKeyframeFx });
      }
    };
    const cardCode = (c) => (ph) => { const e = exprs(c, ph); return { xPercent: xPct(e), yPercent: yPct(e), rotate: e.angle, opacity: e.opacity }; };

    const M = media.length;
    const fill = S.fillEmpty !== false;
    const fit = ['cover', 'contain', 'stretch'].includes(S.imageFit) ? S.imageFit : 'cover';
    const iscale = Math.max(0.05, Number(S.imageScale) || 1);
    const ranks = imageRanks(count);
    const cw = CARD_W * sc, ch = CARD_H * sc;
    cards.forEach((c, k) => {
      // the card: its plate, and its picture clipped into it
      twoPhases({ key: `card[${c.i}]`, type: 'shape', name: `Card ${c.i + 1}`, shapeType: 'rectangle', shapeSizeUnit: 'px',
        shapeWidthPx: r6(cw), shapeHeightPx: r6(ch), shapeFillColor: c.color, borderRadius: r6(CARD_R * sc) }, cardCode(c));
      const rank = ranks.get(c.startSlot);
      const mi = M ? (rank < M ? rank : (fill ? rank % M : -1)) : -1;
      if (mi >= 0) {
        const md = media[mi];
        // the host fits the picture to the card (scriptAssembler fitBox); Image Scale grows it inside the card: the
        // layer is scaled and its mask (the card) shrunk back by the same factor
        const known = Number(md.w) > 0 && Number(md.h) > 0;
        const nw = known ? Number(md.w) : cw, nh = known ? Number(md.h) : ch;
        const kk = Math.min(1, W / nw, H / nh), pw = nw * kk, ph = nh * kk;
        const zoom = fit === 'stretch' ? 1 : fit === 'contain' ? Math.min(cw / pw, ch / ph) : Math.max(cw / pw, ch / ph);
        const dw = fit === 'stretch' ? cw : pw * zoom, dh = fit === 'stretch' ? ch : ph * zoom;
        const scaled = Math.abs(iscale - 1) > 1e-9;
        twoPhases({ key: `card[${c.i}].media`, type: md.type === 'video' ? 'video' : 'image', media: mi, name: `Card ${c.i + 1} picture`,
          box: { w: r6(cw), h: r6(ch), fit, radius: r6(CARD_R * sc) } },
        (ph) => ({ ...cardCode(c)(ph), ...(scaled ? { scale: iscale, 'msk:m1:w': (100 * cw) / (dw * iscale), 'msk:m1:h': (100 * ch) / (dh * iscale) } : {}) }));
      }
      // the seam shadows the next card casts onto this one: drawn after this card, under the next, clipped to this one
      const caster = cards[k + 1];
      if (!caster) return;
      const sf = c.startSlot === -1 || caster.startSlot === -1 ? 0.5 : 1;
      for (const [tag, blur, alpha, share] of TILES) {
        const pad = Math.ceil(blur * 2.5);
        const tw = Math.ceil(CARD_W) + pad * 2, th = Math.ceil(CARD_H) + pad * 2;
        const shift = CARD_H * share * sf;
        // a picture of the blurred card shape (MotionFast's tile), its pixels the box's (no fit, no zoom) and inside the
        // frame (the renderer shrinks a larger picture into it); a scale key brings it to the tile's size
        const f = Math.max(1, (tw * sc) / W, (th * sc) / H) * 1.001;
        const bw = Math.floor((tw * sc) / f), bh = Math.floor((th * sc) / f);
        const grow = (tw * sc) / bw;
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${bw}" height="${bh}" viewBox="0 0 ${tw} ${th}"><defs><filter id="b" filterUnits="userSpaceOnUse" x="0" y="0" width="${tw}" height="${th}"><feGaussianBlur stdDeviation="${blur}"/></filter></defs>`
          + `<rect x="${pad}" y="${pad}" width="${CARD_W}" height="${CARD_H}" rx="${CARD_R}" fill="#000" fill-opacity="${alpha}" filter="url(#b)"/></svg>`;
        twoPhases({
          key: `seam[${c.i}].${tag}`, type: 'image', src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, name: `Shadow on card ${c.i + 1} (${tag})`,
          box: { w: bw, h: bh, fit: 'stretch', radius: 0 },
          layerEffects: [{ id: 'layerMask', eid: 'seam-mask', enabled: true, params: { mskAmount: 100, mskQuality: 0 },
            masks: [{ mid: 'm1', name: 'Card below', mode: 'add', enabled: true, inverted: false,
              path: { points: roundRect8(CARD_R / CARD_W, CARD_R / CARD_H), closed: true },
              x: 0, y: 0, w: r6((100 * CARD_W) / tw), h: r6((100 * CARD_H) / th), rot: 0, feather: 0, expand: 0, opacity: 100, grow: 0 }] }],
        }, (ph) => {
          const e = exprs(caster, ph), er = exprs(c, ph);
          // where it lies: the caster's centre moved `shift` up its own axis, turned with it
          const sx = `+${n(shift)}*sin(${e.angle}*${n(DEG)})`, sy = `-${n(shift)}*cos(${e.angle}*${n(DEG)})`;
          // the card it falls on, in the shadow's own (turned) frame, as shares of the shadow picture: its mask. Both
          // cards ride one wheel, so that is a function of their angle difference Δ alone: R·(cos Δ − 1, sin Δ) + (0,
          // shift); Δ = −15° − 1.69°·env in the first phase, −15° + 1.69°·env in the mirrored one
          const dAng = `(${-STEP_ANGLE}${ph === 1 ? '-' : '+'}${n(MAX_DELTA_DEG - STEP_ANGLE)}*${env})`;
          const op = [er.opacity, e.shadowOpacity].filter(Boolean);
          return {
            xPercent: xPct(e, sx), yPercent: yPct(e, sy), rotate: e.angle,
            'msk:m1:x': `${n(RADIUS)}*(cos(${dAng}*${n(DEG)})-1)*${n(100 / tw)}`,
            'msk:m1:y': `(${n(RADIUS)}*sin(${dAng}*${n(DEG)})+${n(shift)})*${n(100 / th)}`,
            'msk:m1:rot': dAng,
            opacity: op.length ? op.join('*') : null,
            scale: grow,
          };
        });
      }
    });
    const warnings = [];
    if (M && media.some((x) => x.type === 'video')) warnings.push('A video on a card plays once (no loop yet).');
    return { duration: D, layers, warnings };
  },
};
