// Media Orbit (MotionFast `media-orbit-burst`): the first picture opens full frame (or as one centred card) and
// shrinks onto a turning ring of cards that join it one by one (pop, flip, rise, blur); the ring spirals into one
// stacked card, which bursts into a drifting collage at varied depth with depth-of-field blur, or zooms back out to
// cover the frame.
//
// Built from ordinary layers: per card a picture layer for each phase (orbit, converge, burst / cover), each phase's
// keys hold ONE driver (the ring's eased turn, or the burst's eased progress, or the cover zoom's) and a ƒx turns it
// into the place, the size and the blur, MotionFast's formulas verbatim (the converge's ease in-out and the drift are
// written in time). MotionFast paints far to near by its own depth; a flat layer here is drawn by its translateZ, so
// each card stands at a depth that orders it as MotionFast does, its place and size divided by the lens's
// magnification of that depth (exact). Its shadow is a blurred black card on the layer below (Fast Blur, device px as
// the canvas shadow), and the depth / appearance blur a Fast Blur (a placeholder card: soft edges, as the canvas
// filter) or the picture's own blur inside its card with its placeholder blurred under it (a photo: MotionFast clips
// the blurred picture to the card over the blurred fill). Card 0's opening (two eased drivers at once) is keyed by
// samples, 60 a second.
//
// A built-in script (PLANS/ESSENTIAL_TEMPLATES.md §14): it imports nothing, so this same text also runs as a
// `kind: "script"` source. Numbers and timing are MotionFast's (motionTemplates/mediaOrbitBurst.js).
const T = { INTRO: 1.05, ORBIT: 2.20, CONVERGE: 1.15, EXPLODE: 0.80, HOLD: 2.00, ENTER: 0.50 };
const MAX_CARDS = 12;
const CARD_W = 460;
const ASPECTS = { landscape: 3 / 4, wide: 9 / 16, square: 1, portrait: 4 / 3 };
const PLATES = ['#f9492d', '#1d9bf1', '#ffffff', '#33efab'];
const AE_SMOOTH = [0.4, 0, 0.2, 1];
const BURST = [0.16, 0.88, 0.24, 1.06];
const LENS_FOV = 28;                  // the editor's camera (projectCamera.js CAMERA_FOV)
const ZS = 600;                       // px of depth per unit of MotionFast's sort value
const SHADOW = { alpha: 0.38, sigma: 23, dy: 18 };   // canvas shadowBlur 46 (σ = 23), offsetY 18: device px

const fields = [
  { type: 'group', key: 'gMedia', label: 'Media' },
  { key: 'media', type: 'media', label: 'Media (in order)', slots: { from: 'media', max: 12 }, accept: 'media', ifFewer: 'reuse' },
  { type: 'group', key: 'gCards', label: 'Cards' },
  { key: 'cardCount', type: 'range', label: 'Cards', default: 6, min: 3, max: 12, step: 1, integer: true },
  { key: 'cardAspect', type: 'select', label: 'Card aspect', default: 'landscape', options: [
    { value: 'landscape', label: 'Landscape 4:3' }, { value: 'wide', label: 'Wide 16:9' },
    { value: 'square', label: 'Square 1:1' }, { value: 'portrait', label: 'Portrait 3:4' },
  ] },
  { key: 'cardSize', type: 'range', label: 'Card size', default: 100, min: 60, max: 150, step: 2, suffix: '%' },
  { key: 'cornerRadius', type: 'range', label: 'Corner radius', default: 24, min: 0, max: 48, step: 2 },
  { key: 'appearance', type: 'select', label: 'Card appearance', default: 'pop', options: [
    { value: 'pop', label: 'Pop (scale back-out)' }, { value: 'flip', label: '3D flip open' },
    { value: 'rise', label: 'Fade + rise' }, { value: 'blur', label: 'Blur fade' }, { value: 'none', label: 'None' },
  ] },
  { type: 'group', key: 'gOrbit', label: 'Orbit' },
  { key: 'start', type: 'select', label: 'Start', default: 'cover', options: [
    { value: 'cover', label: 'Full Cover (first card shrinks from full frame)' },
    { value: 'single', label: 'Single card (first card waits in the centre)' },
  ] },
  { key: 'ending', type: 'select', label: 'Ending', default: 'burst', options: [
    { value: 'burst', label: 'Burst (chaotic collage)' }, { value: 'cover', label: 'Full Cover (zoom one card to fill)' },
  ] },
  { key: 'orbitTurns', type: 'range', label: 'Orbit turns', default: 0.75, min: 0.25, max: 1.5, step: 0.05 },
  { key: 'cardStagger', type: 'range', label: 'Card stagger', default: 0.16, min: 0.05, max: 0.35, step: 0.01, suffix: 's' },
  { key: 'spread', type: 'range', label: 'Burst spread', default: 100, min: 60, max: 160, step: 5, suffix: '%', showIf: { key: 'ending', equals: 'burst' } },
  { key: 'depth', type: 'range', label: 'Depth range', default: 100, min: 0, max: 200, step: 5, suffix: '%', showIf: { key: 'ending', equals: 'burst' } },
  { key: 'dofBlur', type: 'range', label: 'Depth blur', default: 100, min: 0, max: 200, step: 5, suffix: '%', showIf: { key: 'ending', equals: 'burst' } },
  { key: 'drift', type: 'range', label: 'Drift', default: 100, min: 0, max: 200, step: 5, suffix: '%', showIf: { key: 'ending', equals: 'burst' } },
  { key: 'seed', type: 'range', label: 'Seed', default: 7, min: 1, max: 20, step: 1, integer: true },
  { type: 'group', key: 'gTiming', label: 'Timing' },
  { key: 'speed', type: 'range', label: 'Speed', default: 1, min: 0.5, max: 2, step: 0.05 },
];

const num = (v, d) => { const x = Number(v); return Number.isFinite(x) ? x : d; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const clamp01 = (v) => clamp(v, 0, 1);
const lerp = (a, b, t) => a + (b - a) * t;
const r6 = (v) => { const x = Math.round(v * 1e6) / 1e6; return Object.is(x, -0) ? 0 : x; };
const r4 = (v) => Math.round(v * 1e4) / 1e4;
const n = (v) => { const x = Number(v); return Math.abs(x) < 1e-12 ? '0' : String(Number(x.toPrecision(10))); };
const eio = (t) => { t = clamp01(t); return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; };
const eoc = (t) => 1 - Math.pow(1 - clamp01(t), 3);
const backOut = (t, c1) => { t = clamp01(t); return 1 + (c1 + 1) * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };
function seeded(seed) { let s = seed; return () => { s = (s * 9301 + 49297) % 233280; return s / 233280; }; }   // mtl.makeSeededRandom

// a cubic bezier easing (x handles p[0], p[2]): its exact curve, and the Custom bezier of a piece of it
const bx = (p, u) => 3 * p[0] * u * (1 - u) * (1 - u) + 3 * p[2] * u * u * (1 - u) + u * u * u;
const by = (p, u) => 3 * p[1] * u * (1 - u) * (1 - u) + 3 * p[3] * u * u * (1 - u) + u * u * u;
function solveU(p, x) {
  x = clamp01(x);
  let lo = 0, hi = 1;
  for (let i = 0; i < 60; i += 1) { const m = (lo + hi) / 2; if (bx(p, m) < x) lo = m; else hi = m; }
  return (lo + hi) / 2;
}
const easeOf = (p) => (x) => by(p, solveU(p, x));
// the piece of the curve between x = xa and xb as its own easing (de Casteljau: a piece of a cubic bezier is one)
function piece(p, xa, xb) {
  const ua = solveU(p, xa), ub = solveU(p, xb);
  const pt = (u) => [bx(p, u), by(p, u)];
  const d = (u) => [3 * (1 - u) * (1 - u) * p[0] + 6 * (1 - u) * u * (p[2] - p[0]) + 3 * u * u * (1 - p[2]), 3 * (1 - u) * (1 - u) * p[1] + 6 * (1 - u) * u * (p[3] - p[1]) + 3 * u * u * (1 - p[3])];
  const P0 = pt(ua), P3 = pt(ub), h = (ub - ua) / 3, da = d(ua), db = d(ub);
  const P1 = [P0[0] + da[0] * h, P0[1] + da[1] * h], P2 = [P3[0] - db[0] * h, P3[1] - db[1] * h];
  const dx = P3[0] - P0[0], dy = P3[1] - P0[1];
  if (Math.abs(dy) < 1e-12) return { easing: 'Linear' };
  const k = (v) => Math.round(v * 1e6) / 1e6;
  return { easing: 'Custom', bezier: [k((P1[0] - P0[0]) / dx), k((P1[1] - P0[1]) / dy), k((P2[0] - P0[0]) / dx), k((P2[1] - P0[1]) / dy)] };
}
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

export default {
  id: 'media-orbit-burst',
  name: 'Media Orbit',
  category: 'Carousels',
  v: 1,
  fields,
  build({ settings: P, media, frame }) {
    const { W, H } = frame;
    const sp = num(P.speed, 1) || 1;
    const nCards = Math.max(1, Math.min(MAX_CARDS, Math.round(num(P.cardCount, 6))));
    // MotionFast's timeline (in its time tt = t · speed)
    const introEnd = T.INTRO, orbitEnd = T.INTRO + T.ORBIT, convergeEnd = orbitEnd + T.CONVERGE, explodeEnd = convergeEnd + T.EXPLODE;
    const total = explodeEnd + T.HOLD;
    const D = Math.max(1, total / sp);
    const lastEntry = orbitEnd - T.ENTER - 0.35, firstEntry = T.INTRO * 0.45;
    const stag = nCards > 1 ? Math.min(num(P.cardStagger, 0.16), (lastEntry - firstEntry) / (nCards - 1)) : 0;
    const enter = Array.from({ length: nCards }, (_, i) => (i === 0 ? 0 : firstEntry + (i - 1) * stag));
    // the frame
    const s = H / 1080;
    const tileH = CARD_W * (ASPECTS[P.cardAspect] || ASPECTS.landscape);
    const aspectK = Math.max(0.5, Math.min(1, (W / s) / 1500));
    const bs = 0.92 * aspectK * (num(P.cardSize, 100) / 100);
    const Rx = W * 0.272, Ry = H * 0.235;
    const ZAMP = 400 * s * aspectK, persp = 1600 * s;
    const spinTotal = num(P.orbitTurns, 0.75) * Math.PI * 2;
    const ae = easeOf(AE_SMOOTH), burst = easeOf(BURST);
    const spinFreeze = spinTotal * ae(orbitEnd / convergeEnd);
    const slot0 = (i) => -Math.PI / 2 - (i / nCards) * Math.PI * 2;
    const frozenZ = (i) => Math.sin(slot0(i) + spinFreeze);
    const coverEnd = P.ending === 'cover';
    let frontI = 0;
    if (coverEnd) for (let i = 1; i < nCards; i += 1) if (frozenZ(i) > frozenZ(frontI)) frontI = i;
    const appearance = ['pop', 'flip', 'rise', 'blur', 'none'].includes(P.appearance) ? P.appearance : 'pop';
    const spread = num(P.spread, 100) / 100, depthK = num(P.depth, 100) / 100, dofK = num(P.dofBlur, 100) / 100, da = num(P.drift, 100) / 100;
    const radiusRef = num(P.cornerRadius, 24);
    const SFull = W / CARD_W;
    // the seeded scatter (MotionFast buildScatter)
    const rnd = seeded((num(P.seed, 7) || 1) * 1000 + 17);
    const scatter = [];
    for (let i = 0; i < nCards; i += 1) {
      const a = -Math.PI / 2 - (i / nCards) * Math.PI * 2 + (rnd() - 0.5) * 0.9;
      scatter.push({ a, dist: 0.30 + rnd() * 0.38, z: -0.60 + rnd() * 1.50, rot: (rnd() - 0.5) * 0.16, amp: 0.55 + rnd() * 0.8,
        fx: 0.28 + rnd() * 0.30, fy: 0.24 + rnd() * 0.30, ph: rnd() * Math.PI * 2, ph2: rnd() * Math.PI * 2 });
    }
    // the editor's lens: a flat layer at depth Z is drawn lens / (lens − Z) times larger and that much farther from the
    // centre; c(Z) = (lens − Z) / lens undoes it
    const lens = (H * 0.5) / Math.tan(((LENS_FOV * Math.PI) / 180) * 0.5);
    const cOf = (Z) => (lens - Z) / lens;
    // the card's box (frame px) at the size the ring gathers into (S = s · baseScale): scale tracks are relative to it
    const bw = CARD_W * s * bs, bh = tileH * s * bs, br = radiusRef * s * bs;
    const M = media.length;
    const at4 = (t) => (Math.abs(t - D) < 1e-9 ? r4(D) : Math.floor(t * 1e4 + 1e-7) / 1e4);
    const pos = (t, fs, span) => r6(clamp(((t - fs) / span) * 100, 0, 100));
    const one = (v) => [{ position: 0, value: n(v), easing: 'Linear' }];
    const warnings = [];
    const blurRef = (sig) => sig * (1080 / H) - 0.5;   // Fast Blur: 3 boxes of 2b + 1 px at 1080p: σ = b + 0.5

    // the picture of card i: its photo (the list cycles) or its placeholder plate; the plate as the renderer draws it
    // and the host's cover zoom (as tumble.js pictureOf)
    const pictureOf = (i) => {
      const m = M ? i % M : -1;
      const box = { w: r6(bw), h: r6(bh), fit: 'cover', radius: r6(br) };
      const plate = PLATES[i % PLATES.length];
      const plateSrc = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(box.w)}" height="${Math.round(box.h)}"><rect width="100%" height="100%" fill="${plate}"/></svg>`)}`;
      const pic = m >= 0 ? { type: media[m].type === 'video' ? 'video' : 'image', media: m } : { type: 'image', media: i, src: plateSrc };
      const mm = m >= 0 ? media[m] : null;
      const known = !!(mm && Number(mm.w) > 0 && Number(mm.h) > 0);
      const nw = known ? Number(mm.w) : Math.round(box.w), nh = known ? Number(mm.h) : Math.round(box.h);
      const kk = Math.min(1, W / nw, H / nh);
      const hw = known ? nw : box.w, hh = known ? nh : box.h, hk = Math.min(1, W / hw, H / hh);
      return { pic, box, plate, photo: m >= 0, kk, pw: nw * kk, ph: nh * kk, z0: Math.max(box.w / (hw * hk), box.h / (hh * hk)) };
    };
    const shapeOf = (fill) => ({ type: 'shape', shapeType: 'rectangle', shapeSizeUnit: 'px', shapeWidthPx: r6(bw), shapeHeightPx: r6(bh), shapeFillColor: fill, borderRadius: r6(br) });
    const blurFx = (b0) => [{ id: 'fastBlur', eid: 'blur', enabled: true, mix: 100, params: { blurriness: r6(Math.max(0, b0)), iterations: 3, dimensions: 0, repeatEdges: 0 } }];
    // the layers of one card in one phase from its expressions (in the driver `@`, the layer's `time`):
    //   X, Y (device px from the centre), G (size / the box), F (an extra uniform size), SX (width only), Z (depth),
    //   BL (device blur, 0 for none), ROT (deg); keys: the driver's keys; alpha: opacity keys (null: 1)
    const layers = [];
    const emit = (i, tag, fs, span, keys, ex, alpha, pic) => {
      const sub = (code, shift) => code.split('@').join(shift ? `(value-${shift})` : 'value');
      const track = (shift, code) => ({ keys: keys.map((k) => ({ ...k, value: n(Number(k.value) + shift) })), code: sub(code, shift) });
      const C = `((${n(lens)}-(${ex.Z}))/${n(lens)})`;
      const common = (dy) => {
        const t = {
          xPercent: track(0, `(${ex.X})*${C}*${n(100 / W)}`),
          yPercent: track(0, `((${ex.Y})${dy ? `+${n(dy)}` : ''})*${C}*${n(100 / H)}`),
          translateZ: track(0, ex.Z),
        };
        if (ex.ROT) t.rotate = track(0, ex.ROT);
        if (ex.SX) t.scaleX = track(1, ex.SX);
        return t;
      };
      const out = (key, base, tracks, extra) => {
        const propertyKeyframes = {}, propertyKeyframeFx = {};
        for (const [k, v] of Object.entries(tracks)) {
          if (Array.isArray(v)) { propertyKeyframes[k] = v; continue; }
          propertyKeyframes[k] = v.keys;
          propertyKeyframeFx[k] = { type: 'custom', params: { code: v.code } };
        }
        layers.push({ ...base, key, freeStart: fs, trimEnd: r6(span), ...extra, propertyKeyframes, propertyKeyframeFx });
      };
      const G = `(${ex.G})*(${ex.F || '1'})`;
      const blurOn = !!ex.BL;
      // the shadow: a black card 18 px lower, 38 % of the card's opacity, blurred σ 23 px (and by the card's blur)
      const sh = common(SHADOW.dy);
      sh.scale = track(1, `${G}*${C}`);
      sh['fx:blur:blurriness'] = track(0, blurOn ? `max(0,(((${ex.BL})>0.4)?sqrt(${n(SHADOW.sigma * SHADOW.sigma)}+pow(${ex.BL},2)):${n(SHADOW.sigma)})*${n(1080 / H)}-0.5)` : n(blurRef(SHADOW.sigma)));
      if (alpha) sh.opacity = alpha.map((k) => ({ ...k, value: n(Number(k.value) * SHADOW.alpha) }));
      out(`card[${i}].${tag}.shadow`, { ...shapeOf('#000000'), name: `Card ${i + 1} shadow`, track: `card[${i}].shadow` }, sh,
        { ...(alpha ? {} : { opacity: SHADOW.alpha * 100 }), effects: blurFx(blurRef(SHADOW.sigma)) });
      // MotionFast fills a photo card with its placeholder colour, then clips the picture into it: the fill shows where
      // the card fades (its appearance) or blurs (a blurred fill under the picture blurred inside its card)
      const fxBlur = blurOn ? `max(0,(((${ex.BL})>0.4)?(${ex.BL})*${n(1080 / H)}-0.5:0))` : null;
      if (pic.photo && (blurOn || alpha)) {
        const pl = common(0);
        pl.scale = track(1, `${G}*${C}`);
        if (blurOn) pl['fx:blur:blurriness'] = track(0, fxBlur);
        if (alpha) pl.opacity = alpha;
        out(`card[${i}].${tag}.fill`, { ...shapeOf(pic.plate), name: `Card ${i + 1} fill`, track: `card[${i}].fill` }, pl, blurOn ? { effects: blurFx(0) } : {});
      }
      const cd = common(0);
      cd.scale = track(1, `${G}*${C}`);
      if (alpha) cd.opacity = alpha;
      let extra = {};
      if (blurOn && pic.photo) cd.blur = track(0, `((${ex.BL})>0.4?(${ex.BL})/(${n(pic.kk * pic.z0)}*${G}):0)`);   // the layer blur counts the photo's own pixels
      else if (blurOn) { cd['fx:blur:blurriness'] = track(0, fxBlur); extra = { effects: blurFx(0) }; }
      if (ex.mask) Object.assign(cd, ex.mask.tracks(track));
      out(`card[${i}].${tag}`, { ...pic.pic, box: pic.box, name: `Card ${i + 1}`, track: `card[${i}]` }, cd, { ...extra, ...(ex.mask ? { layerEffects: ex.mask.effects } : {}) });
    };
    // the driver's keys over a layer: one piece of an eased curve (u from xa to xb of the curve, at t0 … t1), then held
    const driverKeys = (p, ease, xa, xb, t0, t1, fs, span) => {
      const ya = ease(xa), yb = ease(xb);
      const keys = [{ position: pos(t0, fs, span), value: n(ya), ...piece(p, xa, xb) }, { position: pos(t1, fs, span), value: n(yb), easing: 'Linear' }];
      if (keys[0].position > 0) keys.unshift({ position: 0, value: n(ya), easing: 'Linear' });
      if (keys[keys.length - 1].position < 100) keys.push({ position: 100, value: n(yb), easing: 'Linear' });
      return keys;
    };
    // the appearance's opacity keys (exact: straight ramps; rise's ease-out cubic is a Custom bezier)
    const alphaKeys = (e0, fs, span) => {
      const t0 = e0 / sp, tEnd = (e0 + T.ENTER) / sp;
      if (appearance === 'none') return null;
      const k = [];
      const reach = appearance === 'rise' ? 1 : appearance === 'blur' ? 0.5 : 0.35;
      k.push({ position: pos(t0, fs, span), value: '0', ...(appearance === 'rise' ? { easing: 'Custom', bezier: [0.3333, 1, 0.6667, 1] } : { easing: 'Linear' }) });
      k.push({ position: pos(t0 + (tEnd - t0) * reach, fs, span), value: '1', easing: 'Linear' });
      if (k[1].position < 100) k.push({ position: 100, value: '1', easing: 'Linear' });
      return k;
    };
    const TT = (fs) => `((time+${n(fs)})*${n(sp)})`;

    for (let i = 0; i < nCards; i += 1) {
      const pic = pictureOf(i);
      const a0 = slot0(i);
      const sinS = `sin(${n(a0)}+${n(spinTotal)}*@)`, cosS = `cos(${n(a0)}+${n(spinTotal)}*@)`;
      // ── card 0's opening: the cover (or the single card) eases onto the ring, keyed by samples ──
      let orbitFrom = enter[i];
      if (i === 0) {
        orbitFrom = introEnd;
        const t1 = introEnd / sp, fs = 0, span = at4(t1);
        const cover = P.start !== 'single';
        const at = (t) => {
          const tt = t * sp, mmv = ae(clamp01(tt / T.INTRO)), slot = a0 + spinTotal * ae(clamp01(tt / convergeEnd));
          const z = Math.sin(slot) * ZAMP, k = persp / (persp - z);
          const Sr = s * k * bs;
          const S = cover ? lerp(SFull, Sr, mmv) : lerp(s * bs, Sr, mmv);
          const th = cover ? lerp(H / SFull, tileH, mmv) : tileH;
          const rad = cover ? lerp(0.001, radiusRef, mmv) : radiusRef;
          return { x: lerp(0, Math.cos(slot) * Rx, mmv), y: lerp(0, Math.sin(slot) * Ry, mmv), S, th, rad, Z: ZS * Math.sin(slot) };
        };
        const steps = Math.max(2, Math.ceil(t1 * 60));
        const samp = (f) => Array.from({ length: steps + 1 }, (_, j) => { const t = (t1 * j) / steps; return { position: pos(t, fs, span), value: n(f(at(t), t)), easing: 'Linear' }; });
        const C = (q) => cOf(q.Z);
        // the card: its cover of the box grows with its height (MotionFast's tile is CARD_W × th at S)
        const cov = (q) => Math.max(CARD_W / pic.pw, q.th / pic.ph);
        const pathSteps = Math.max(2, Math.ceil(t1 * 30));
        const cardTracks = {
          xPercent: samp((q) => (q.x * C(q) * 100) / W), yPercent: samp((q) => (q.y * C(q) * 100) / H), translateZ: samp((q) => q.Z),
          scale: samp((q) => (q.S * cov(q) * C(q)) / pic.z0),
          'msk:m1:w': samp((q) => (100 * CARD_W) / (pic.pw * cov(q))), 'msk:m1:h': samp((q) => (100 * q.th) / (pic.ph * cov(q))),
          'msk:m1:path': Array.from({ length: pathSteps + 1 }, (_, j) => { const t = (t1 * j) / pathSteps; const q = at(t); return { position: pos(t, fs, span), value: JSON.stringify(roundRect8(clamp(q.rad / CARD_W, 0, 0.5), clamp(q.rad / q.th, 0, 0.5))), easing: 'Linear' }; }),
        };
        const q0 = at(0);
        const mask = { id: 'layerMask', eid: 'box-mask', enabled: true, params: { mskAmount: 100, mskQuality: 0 },
          masks: [{ mid: 'm1', name: 'Box', mode: 'add', enabled: true, inverted: false, path: { points: roundRect8(0, 0), closed: true },
            x: 0, y: 0, w: r6((100 * CARD_W) / (pic.pw * cov(q0))), h: r6((100 * q0.th) / (pic.ph * cov(q0))), rot: 0, feather: 0, expand: 0, opacity: 100, grow: 0 }] };
        const shTracks = {
          xPercent: samp((q) => (q.x * C(q) * 100) / W), yPercent: samp((q) => ((q.y + SHADOW.dy) * C(q) * 100) / H), translateZ: samp((q) => q.Z),
          scaleX: samp((q) => (q.S * CARD_W * C(q)) / bw), scaleY: samp((q) => (q.S * q.th * C(q)) / bh),
        };
        layers.push({ ...shapeOf('#000000'), key: `card[0].intro.shadow`, name: 'Card 1 shadow', track: 'card[0].shadow', freeStart: fs, trimEnd: r6(span),
          opacity: SHADOW.alpha * 100, effects: blurFx(blurRef(SHADOW.sigma)), propertyKeyframes: shTracks });
        layers.push({ ...pic.pic, box: pic.box, key: 'card[0].intro', name: 'Card 1', track: 'card[0]', freeStart: fs, trimEnd: r6(span),
          layerEffects: [mask], propertyKeyframes: cardTracks });
      }
      // ── the orbit: the ring turns (rr = 1), the card joins with its appearance ──
      {
        const t0 = orbitFrom / sp, t1 = orbitEnd / sp, fs = at4(t0), span = at4(t1) - fs;
        const keys = driverKeys(AE_SMOOTH, ae, (fs * sp) / convergeEnd, orbitEnd / convergeEnd, fs, t1, fs, span);
        const k = `(${n(persp)}/(${n(persp)}-${sinS}*${n(ZAMP)}))`;
        const E = `clamp((${TT(fs)}-${n(enter[i])})/${n(T.ENTER)},0,1)`;
        const ex = { X: `${n(Rx)}*${cosS}`, Y: `${n(Ry)}*${sinS}`, G: k, Z: `${n(ZS)}*${sinS}` };
        if (i > 0 && appearance === 'pop') ex.F = `max(0.02,1+2.5*pow(${E}-1,3)+1.5*pow(${E}-1,2))`;
        if (i > 0 && appearance === 'flip') ex.SX = `max(0.02,1+2.2*pow(${E}-1,3)+1.2*pow(${E}-1,2))`;
        if (i > 0 && appearance === 'rise') ex.Y = `${n(Ry)}*${sinS}+${n(64 * s)}*pow(1-${E},3)`;
        if (i > 0 && appearance === 'blur') { ex.F = `(1+0.14*pow(1-${E},3))`; ex.BL = `${n(16 * s * bs)}*pow(1-${E},3)*${k}`; }
        emit(i, 'orbit', fs, span, keys, ex, i > 0 ? alphaKeys(enter[i], fs, span) : null, pic);
      }
      // ── the converge: the ring's radius and depth ease to 0; the painter's order is frozen ──
      {
        const t0 = orbitEnd / sp, t1 = convergeEnd / sp, fs = at4(t0), span = at4(t1) - fs;
        const keys = driverKeys(AE_SMOOTH, ae, (fs * sp) / convergeEnd, 1, fs, t1, fs, span);
        const Q = `clamp((${TT(fs)}-${n(orbitEnd)})/${n(T.CONVERGE)},0,1)`;
        const rr = `(1-(${Q}<0.5?4*pow(${Q},3):1-pow(2-2*${Q},3)/2))`;
        const ex = { X: `${n(Rx)}*${cosS}*${rr}`, Y: `${n(Ry)}*${sinS}*${rr}`, G: `(${n(persp)}/(${n(persp)}-${sinS}*${n(ZAMP)}*${rr}))`, Z: n(ZS * frozenZ(i)) };
        emit(i, 'converge', fs, span, keys, ex, null, pic);
      }
      // ── the ending ──
      const t0 = convergeEnd / sp, fs = at4(t0), span = at4(D) - fs;
      if (!coverEnd) {
        // the burst to the seeded scatter, at varied depth, drifting, with depth-of-field blur
        const sc = scatter[i];
        const halfDiag = Math.hypot(W, H) / 2;
        const tx = Math.cos(sc.a) * halfDiag * sc.dist * spread, ty = Math.sin(sc.a) * halfDiag * sc.dist * spread * 0.92;
        const kS = persp / (persp - sc.z * 640 * s * depthK);
        const focusD = sc.z - 0.15;
        const dof = Math.abs(focusD) * (focusD > 0 ? 12 : 18) * dofK * s;
        const keys = driverKeys(BURST, burst, 0, 1, t0, explodeEnd / sp, fs, span);
        const DT = `(${TT(fs)}-${n(convergeEnd)})`;
        const ex = {
          X: `(${n(tx)}+sin(${DT}*${n(sc.fx * Math.PI * 2)}+${n(sc.ph)})*${n(16 * s * sc.amp * da)})*@`,
          Y: `(${n(ty)}+sin(${DT}*${n(sc.fy * Math.PI * 2)}+${n(sc.ph2)})*${n(13 * s * sc.amp * da)})*@`,
          G: `(1+${n(kS - 1)}*@)*(1-0.1*@)`, Z: n(ZS * sc.z),
          ROT: `(${n(sc.rot)}+sin(${DT}*${n(0.5 * Math.PI * 2 * sc.fx)}+${n(sc.ph)})*${n(0.02 * da)})*@*${n(180 / Math.PI)}`,
          ...(dof > 0.4 ? { BL: `${n(dof)}*@` } : {}),
        };
        emit(i, 'burst', fs, span, keys, ex, null, pic);
      } else {
        // the stack holds; the front card zooms back out to cover the frame (the opening, reversed)
        const Z = ZS * frozenZ(i);
        if (i !== frontI) emit(i, 'end', fs, span, [{ position: 0, value: '0', easing: 'Linear' }], { X: '0', Y: '0', G: '1', Z: n(Z) }, null, pic);
        else {
          const keys = driverKeys(AE_SMOOTH, ae, 0, 1, t0, explodeEnd / sp, fs, span);
          // S = s·bs·(1 + (SFull/(s·bs) − 1)·mm), th = tileH + (H/SFull − tileH)·mm, radius = r + (0.001 − r)·mm
          const Sx = `(1+${n(SFull / (s * bs) - 1)}*@)`, th = `(${n(tileH)}+${n(H / SFull - tileH)}*@)`;
          const cov = `max(${n(CARD_W / pic.pw)},${th}/${n(pic.ph)})`;
          const ex = { X: '0', Y: '0', G: '1', Z: n(Z) };
          const C = cOf(Z);
          ex.mask = {
            effects: [{ id: 'layerMask', eid: 'box-mask', enabled: true, params: { mskAmount: 100, mskQuality: 0 },
              masks: [{ mid: 'm1', name: 'Box', mode: 'add', enabled: true, inverted: false, path: { points: roundRect8(0, 0), closed: true },
                x: 0, y: 0, w: r6((100 * CARD_W) / (pic.pw * Math.max(CARD_W / pic.pw, tileH / pic.ph))), h: r6((100 * tileH) / (pic.ph * Math.max(CARD_W / pic.pw, tileH / pic.ph))), rot: 0, feather: 0, expand: 0, opacity: 100, grow: 0 }] }],
            tracks: (track) => {
              const steps = Math.max(2, Math.ceil(((explodeEnd - convergeEnd) / sp) * 30));
              const path = [];
              for (let j = 0; j <= steps; j += 1) {
                const t = t0 + (((explodeEnd - convergeEnd) / sp) * j) / steps, mmv = ae(clamp01((t * sp - convergeEnd) / T.EXPLODE));
                const rad = lerp(radiusRef, 0.001, mmv), thv = lerp(tileH, H / SFull, mmv);
                path.push({ position: pos(t, fs, span), value: JSON.stringify(roundRect8(clamp(rad / CARD_W, 0, 0.5), clamp(rad / thv, 0, 0.5))), easing: 'Linear' });
              }
              if (path[path.length - 1].position < 100) path.push({ ...path[path.length - 1], position: 100 });
              return {
                // the picture: S · its cover of the card (CARD_W × th) / the host's zoom, through the lens's c
                scale: track(1, `${n((s * bs) / pic.z0 * C)}*${Sx}*${cov}`),
                'msk:m1:w': track(2, `${n(100 * CARD_W / pic.pw)}/${cov}`),
                'msk:m1:h': track(2, `100*${th}/(${n(pic.ph)}*${cov})`),
                'msk:m1:path': path,
              };
            },
          };
          // its shadow grows the same way (a box of bw × bh: width and height scale apart)
          ex.shadowSize = { sx: `${Sx}`, sy: `${Sx}*${th}/${n(tileH)}` };
          emitCoverFront(i, fs, span, keys, ex, pic, C);
        }
      }
    }
    // the front card of the cover ending: its own mask (keys above), its shadow sized by width and height
    function emitCoverFront(i, fs, span, keys, ex, pic, C) {
      const sub = (code, shift) => code.split('@').join(shift ? `(value-${shift})` : 'value');
      const track = (shift, code) => ({ keys: keys.map((k) => ({ ...k, value: n(Number(k.value) + shift) })), code: sub(code, shift) });
      const fxOf = (tracks) => {
        const propertyKeyframes = {}, propertyKeyframeFx = {};
        for (const [k, v] of Object.entries(tracks)) {
          if (Array.isArray(v)) { propertyKeyframes[k] = v; continue; }
          propertyKeyframes[k] = v.keys;
          propertyKeyframeFx[k] = { type: 'custom', params: { code: v.code } };
        }
        return { propertyKeyframes, ...(Object.keys(propertyKeyframeFx).length ? { propertyKeyframeFx } : {}) };
      };
      layers.push({ ...shapeOf('#000000'), key: `card[${i}].end.shadow`, name: `Card ${i + 1} shadow`, track: `card[${i}].shadow`, freeStart: fs, trimEnd: r6(span),
        opacity: SHADOW.alpha * 100, effects: blurFx(blurRef(SHADOW.sigma)),
        ...fxOf({ yPercent: one((SHADOW.dy * C * 100) / H), translateZ: one(ex.Z), scaleX: track(1, `${ex.shadowSize.sx}*${n(C)}`), scaleY: track(1, `${ex.shadowSize.sy}*${n(C)}`) }) });
      layers.push({ ...pic.pic, box: pic.box, key: `card[${i}].end`, name: `Card ${i + 1}`, track: `card[${i}]`, freeStart: fs, trimEnd: r6(span),
        layerEffects: ex.mask.effects, ...fxOf({ translateZ: one(ex.Z), ...ex.mask.tracks(track) }) });
    }
    if (M && media.some((x) => x.type === 'video')) warnings.push('A video on a card plays once (no loop yet).');
    // channels: per card its shadow, its fill, its picture (cards in index order: level cards paint in index order, as
    // MotionFast's stable sort); a track's layers stay in time order
    const rank = (ly) => { const m = /^card\[(\d+)\]\.[a-z]+(\.(shadow|fill))?$/.exec(ly.key); return Number(m[1]) * 3 + (m[3] === 'shadow' ? 0 : m[3] === 'fill' ? 1 : 2); };
    const ordered = layers.map((ly, j) => [rank(ly), j, ly]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((x) => x[2]);
    return { duration: D, layers: ordered, warnings };
  },
};
