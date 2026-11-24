// Scatter Cards (MotionFast `scatter-cards-flow`): a 400 × 300 stage of scattered rounded cards in three columns plus
// one static card. Every cycle each column advances one slot on the 'natural' ease: the middle and right columns are
// conveyors (a card enters from beyond the edge, crosses the centre, leaves), the left column is a closed loop of
// three cards whose bottom card flies out and comes back from above.
//
// Built from ordinary layers: one card per life (a conveyor card lives four cycles, a left card three between its
// return and its exit), its place and turn keyed at the cycle boundaries with the app's Natural easing (the same bezier
// as MotionFast's 'natural', so the keys draw it exactly), its picture (fitted cover / contain / stretch, scaled inside
// the card) on top of its plate. MotionFast paints by (z, DOM order) and lifts some middle cards above the rest once
// they reach the centre: such a card is two layers on two channels, so the channel order is MotionFast's order at
// every frame. "Contain (whole stage)" cuts the cards at the stage's edge: every card is matted by one stage rectangle.
//
// A built-in script (PLANS/ESSENTIAL_TEMPLATES.md §14): it imports nothing, so this same text also runs as a
// `kind: "script"` source. Numbers and timing are MotionFast's (motionTemplates/scatterCardsFlow.js).
const STAGE_W = 400;
const STAGE_H = 300;
const CARD_W = 144;
const CARD_H = 90;
const CARD_R = 8;
const SLOT1 = { x: 128, y: 105, rotation: -15 };
const SLOT2 = { x: 90, y: 219, rotation: 10 };
const SLOT3 = { x: 96, y: -55, rotation: 32 };
const EXIT_M = { x: 96, y: -255, rotation: 32 };
const ENTRY_M = { x: 90, y: 419, rotation: 10 };
const SLOT4 = { x: 298, y: 141, rotation: 25 };
const SLOT5 = { x: 235, y: 3, rotation: -34 };
const SLOT6 = { x: 235, y: 260, rotation: -40 };
const EXIT_R = { x: 235, y: 460, rotation: -40 };
const ENTRY_R = { x: 235, y: -197, rotation: -34 };
const SLOT7 = { x: 35, y: 37, rotation: 103 };
const SLOT8 = { x: -72, y: 193, rotation: 145 };
const SLOT9 = { x: -13, y: -152, rotation: 53 };
const EXIT_L = { x: -268, y: 225, rotation: 193 };
const TECH10 = { x: -268, y: 225, rotation: -167 };
const MID_COLORS = ['#f9492d', '#1d9bf1', '#ffffff'];
const RIGHT_COLORS = ['#33efab', '#ffffff', '#f9492d'];
const LEFT_COLORS = ['#1d9bf1', '#33efab', '#ffffff'];
const STATIC_COLOR = '#f9492d';
// the media list fills the two centre cards and the static card first, then outward (by column + colour)
const MEDIA_RANK = { m1: 0, r1: 1, s: 2, l0: 3, m0: 4, r0: 5, l1: 6, m2: 7, r2: 8, l2: 9 };

const fields = [
  { type: 'group', key: 'gMedia', label: 'Media' },
  { key: 'media', type: 'media', label: 'Images / videos (fill from center)', slots: { from: 'media', max: 10 }, accept: 'media', ifFewer: 'keep' },
  { key: 'fillEmpty', type: 'switch', label: 'Copy media to empty cards', default: false },
  { key: 'imageFit', type: 'select', label: 'Media Fit', default: 'cover', options: [
    { value: 'cover', label: 'Cover (fill card)' }, { value: 'contain', label: 'Contain (fit inside)' }, { value: 'stretch', label: 'Stretch' },
  ] },
  { key: 'imageScale', type: 'range', label: 'Media Scale', default: 1, min: 0.5, max: 2, step: 0.05, suffix: 'x' },
  { type: 'group', key: 'gFlow', label: 'Flow' },
  { key: 'speed', type: 'range', label: 'Speed', default: 1, min: 0.25, max: 3, step: 0.05 },
  { key: 'cycles', type: 'range', label: 'Cycles', default: 9, min: 1, max: 20, step: 1, integer: true },
  { key: 'fit', type: 'select', label: 'Stage Fit', default: 'cover', options: [
    { value: 'cover', label: 'Cover (fill frame)' }, { value: 'contain', label: 'Contain (whole stage)' },
  ] },
];

const r6 = (v) => { const x = Math.round(v * 1e6) / 1e6; return Object.is(x, -0) ? 0 : x; };
const r4 = (v) => Math.round(v * 1e4) / 1e4;
const n = (v) => { const x = Number(v); return Math.abs(x) < 1e-12 ? '0' : String(Number(x.toPrecision(10))); };
const genIndex = (g) => (((-g) % 3) + 3) % 3;
// MotionFast's z bumps of the middle column (its GSAP timeline, built up front)
const midZ = (g, k) => {
  if ((g === 2 || g === 3 || g === 5 || g === 6 || g === 8) && k >= g) return 20;
  if (g === 0) return 7;
  if (g === -1) return 10;
  return 0;
};

export default {
  id: 'scatter-cards-flow',
  name: 'Scatter Cards',
  category: 'Carousels',
  v: 1,
  fields,
  build({ settings: P, media, frame }) {
    const { W, H } = frame;
    const sp = Math.max(0.05, Number(P.speed) || 1);
    const cycles = Math.max(1, Math.round(Number(P.cycles) || 9));
    const cyc = 1 / sp;                                    // seconds a cycle
    const D = Math.round(cycles * cyc * 1e9) / 1e9;
    const contain = P.fit === 'contain';
    const scale = contain ? Math.min(W / STAGE_W, H / STAGE_H) : Math.max(W / STAGE_W, H / STAGE_H);
    // the stage on whole pixels, as MotionFast clips it
    const stageW = Math.round(STAGE_W * scale), stageH = Math.round(STAGE_H * scale);
    const offX = Math.round((W - stageW) / 2), offY = Math.round((H - stageH) / 2);
    const clipStage = stageW < W || stageH < H;
    const cx = (p) => offX + (p.x + CARD_W / 2) * scale - W / 2, cy = (p) => offY + (p.y + CARD_H / 2) * scale - H / 2;
    const cw = CARD_W * scale, ch = CARD_H * scale, cr = CARD_R * scale;
    const M = media.length;
    const fill = !!P.fillEmpty;
    const fit = ['cover', 'contain', 'stretch'].includes(P.imageFit) ? P.imageFit : 'cover';
    const iscale = Number(P.imageScale) || 1;
    const mediaOf = (key) => { if (!M) return -1; const rank = MEDIA_RANK[key]; return rank < M ? rank : fill ? rank % M : -1; };
    // a layer's start and end on the host's 1/10000 s: every life has its own channel, so a layer starts at its first key
    // rounded down and ends at its last rounded up, and every key sits at its own time
    const down4 = (t) => (Math.abs(t - D) < 1e-9 ? r4(D) : Math.floor(t * 1e4 + 1e-7) / 1e4);
    const up4 = (t) => (Math.abs(t - D) < 1e-9 ? r4(D) : Math.min(r4(D), Math.ceil(t * 1e4 - 1e-7) / 1e4));

    // the lives: [{ key, color, mediaKey, z, order, from (cycle), stops: [pose at from, from + 1, …] }]
    const lives = [];
    const conveyor = (prefix, colors, path, zOf, orderOf) => {
      // generation g: cycle g − 1 entry → entry slot, g: → centre, g + 1: → exit slot, g + 2: → beyond the edge
      for (let g = -2; g <= cycles; g += 1) {
        const idx = genIndex(g);
        const first = g - 1;
        // split where its z changes (a middle card lifted above the rest at the centre)
        let a = Math.max(0, first), end = Math.min(cycles, first + 4);
        while (a < end) {
          let b = a + 1;
          while (b < end && zOf(g, b) === zOf(g, a)) b += 1;
          lives.push({ key: `${prefix}[${g + 2}]${b < end || a > Math.max(0, first) ? `.${a}` : ''}`, track: `${prefix}[${g + 2}].z${zOf(g, a)}`,
            color: colors[idx], mediaKey: `${prefix[0]}${idx}`, z: zOf(g, a), order: orderOf(g), from: a, stops: path.slice(a - first, b - first + 1) });
          a = b;
        }
      }
    };
    conveyor('mid', MID_COLORS, [ENTRY_M, SLOT2, SLOT1, SLOT3, EXIT_M], midZ, (g) => (g <= 0 ? 1 - g : 10 + (g - 1) * 2));
    conveyor('right', RIGHT_COLORS, [ENTRY_R, SLOT5, SLOT4, SLOT6, EXIT_R], () => 0, (g) => (g <= 0 ? 4 - g : 10 + (g - 1) * 2 + 1));
    // the left loop: a card returns above the frame (slot 9 → 7), steps down (7 → 8), flies out (8 → out) and is
    // teleported back at the cycle's end: one life = those three cycles
    for (let j = -2; j < cycles; j += 1) {
      const idx = genIndex(j - 2);
      const a = Math.max(0, j), b = Math.min(cycles, j + 3);
      if (b <= a) continue;
      lives.push({ key: `left[${j + 2}]`, track: `left[${j + 2}]`, color: LEFT_COLORS[idx], mediaKey: `l${idx}`, z: 6, order: 7 + idx, from: a,
        stops: [SLOT9, SLOT7, SLOT8, EXIT_L].slice(a - j, b - j + 1) });
    }
    lives.push({ key: 'static', track: 'static', color: STATIC_COLOR, mediaKey: 's', z: 0, order: 0, from: 0, stops: [TECH10], still: true });

    // xPercent / yPercent keys stay inside ±200 %: a far exit (a portrait frame) holds value / k and a ƒx takes k back
    let reach = 0;
    for (const L of lives) for (const p of L.stops) reach = Math.max(reach, Math.abs((cx(p) * 100) / W), Math.abs((cy(p) * 100) / H));
    const kPos = reach > 190 ? Math.ceil(reach / 190) : 1;
    const layers = [];
    if (clipStage) {
      // the stage: the matte every card is cut by (MotionFast clips to it); hidden by the editor as a matte source
      layers.push({ key: 'stage', type: 'shape', name: 'Stage', shapeType: 'rectangle', shapeSizeUnit: 'px', shapeWidthPx: stageW, shapeHeightPx: stageH,
        shapeFillColor: '#ffffff', panX: r6(((offX + stageW / 2 - W / 2) / W) * 100), panY: r6((-(offY + stageH / 2 - H / 2) / H) * 100), ord: [-1, 0, 0] });
    }
    const matte = clipStage ? { trackMatte: { sourceId: 'stage', mode: 'alpha' } } : {};
    lives.forEach((L, li) => {
      const fs = L.still ? 0 : down4(L.from * cyc);
      const end = L.still ? r4(D) : up4(Math.min(cycles, L.from + L.stops.length - 1) * cyc);
      const span = r4(end - fs);
      // keys at the cycle boundaries, Natural between (MotionFast's 'natural' bezier), the last one held
      const keys = (f) => L.stops.map((p, j) => ({ position: L.still ? 0 : r6(Math.min(100, Math.max(0, (((L.from + j) * cyc - fs) / span) * 100))),
        value: n(f(p)), easing: j < L.stops.length - 1 ? 'Natural' : 'Linear' }));
      const tracks = {
        xPercent: keys((p) => (cx(p) * 100) / W / kPos),
        yPercent: keys((p) => (cy(p) * 100) / H / kPos),
        rotate: keys((p) => p.rotation),
      };
      const fx = kPos > 1 ? { xPercent: { type: 'custom', params: { code: `value*${kPos}` } }, yPercent: { type: 'custom', params: { code: `value*${kPos}` } } } : null;
      const base = { freeStart: fs, trimEnd: span, track: L.track, ...matte, propertyKeyframes: tracks, ...(fx ? { propertyKeyframeFx: fx } : {}) };
      const name = L.key === 'static' ? 'Static card' : `Card ${L.key.replace(/\.\d+$/, '')}`;
      layers.push({ ...base, key: `${L.key}.card`, type: 'shape', name, shapeType: 'rectangle', shapeSizeUnit: 'px', shapeWidthPx: r6(cw), shapeHeightPx: r6(ch),
        shapeFillColor: L.color, borderRadius: r6(cr), ord: [L.z, L.order, li * 2] });
      const mi = mediaOf(L.mediaKey);
      if (mi >= 0) {
        const md = media[mi];
        const extra = {};
        if (Math.abs(iscale - 1) > 1e-9) {
          // Media Scale: the picture grows inside the card (the layer scaled, its mask, the card, shrunk back)
          const known = Number(md.w) > 0 && Number(md.h) > 0;
          const nw = known ? Number(md.w) : cw, nh = known ? Number(md.h) : ch;
          const kk = Math.min(1, W / nw, H / nh), pw = nw * kk, ph = nh * kk;
          const zoom = fit === 'stretch' ? 1 : fit === 'contain' ? Math.min(cw / pw, ch / ph) : Math.max(cw / pw, ch / ph);
          const dw = fit === 'stretch' ? cw : pw * zoom, dh = fit === 'stretch' ? ch : ph * zoom;
          extra.scale = [{ position: 0, value: n(iscale), easing: 'Linear' }];
          extra['msk:m1:w'] = [{ position: 0, value: n((100 * cw) / (dw * iscale)), easing: 'Linear' }];
          extra['msk:m1:h'] = [{ position: 0, value: n((100 * ch) / (dh * iscale)), easing: 'Linear' }];
        }
        layers.push({ ...base, key: `${L.key}.picture`, track: `${L.track}.picture`, type: md.type === 'video' ? 'video' : 'image', media: mi, name: `${name} picture`,
          box: { w: r6(cw), h: r6(ch), fit, radius: r6(cr) }, propertyKeyframes: { ...tracks, ...extra }, ord: [L.z, L.order, li * 2 + 1] });
      }
    });
    // channels in MotionFast's paint order: (z, DOM order), a card's picture right over its plate
    const ordered = layers.map((ly, j) => [ly, j]).sort((a, b) => a[0].ord[0] - b[0].ord[0] || a[0].ord[1] - b[0].ord[1] || a[0].ord[2] - b[0].ord[2] || a[1] - b[1])
      .map(([ly]) => { const { ord, ...rest } = ly; return rest; });
    const warnings = [];
    if (M && media.some((x) => x.type === 'video')) warnings.push('A video on a card plays once (no loop yet).');
    return { duration: D, layers: ordered, warnings };
  },
};
