// 3D Grid (MotionFast `grid-3d-reveal`): a columns × rows mosaic of picture cards bursts out of a stack, every card
// tilted in 3D and turned, holds as a mosaic while the whole grid swings, then gathers back into the stack.
//
// Built from ordinary layers in real 3D: a Swing null (the picture's turn about the frame centre and the scale that
// puts MotionFast's 2400 px perspective in front of the editor's lens), a Grid null under it (the grid's turn about
// Y), and per card a Slot null (its place in the grid and its own turn about Y) holding the card's picture (its tilt
// about X, its turn and its size). The editor's layer turns are X·Y·Z; MotionFast turns a card Z, then X, then Y,
// which is why the Y turn sits on the slot. Every value is a + b·s(t) of one envelope s (an ease in-out cubic each
// way): each half of an ease in-out cubic is a cubic in time, which a Custom bezier with x handles at 1/3, 2/3 draws
// exactly, so every track is a few keys. The camera only zooms: camZoom = 2400 / D and the Swing null's scale D / 2400
// (D the editor's lens distance) film the cards from 2400 px, as MotionFast projects them.
//
// A built-in script (PLANS/ESSENTIAL_TEMPLATES.md §14): it imports nothing, so this same text also runs as a
// `kind: "script"` source. Numbers and timing are MotionFast's (motionTemplates/grid3dReveal.js).
const PLATES = ['#f9492d', '#1d9bf1', '#ffffff', '#33efab', '#f9492d', '#ffffff'];
const BASE_DURATION = 78 / 25;
const PERSPECTIVE = 2400;
const LENS_FOV = 28;                      // the editor's camera (projectCamera.js CAMERA_FOV)
// the envelope (0 → 1 → 0) and the two swings, in the clip's share of time: MotionFast's keys, ease in-out cubic between
const RISE = [6 / 78, 33 / 78], FALL = [54 / 78, 72 / 78];
const DUP_ROTZ_KEYS = [[6 / 78, 0], [29 / 78, -24], [55 / 78, 38], [72 / 78, 0]];
const GRID_ROTY_KEYS = [[6 / 78, 0], [30 / 78, -14], [72 / 78, 0]];
// the two halves of an ease in-out cubic as Custom beziers (exact: u³ and 1 − (1 − u)³ with x handles at 1/3, 2/3)
const EASE_IN_HALF = { easing: 'Custom', bezier: [0.3333, 0, 0.6667, 0] };
const EASE_OUT_HALF = { easing: 'Custom', bezier: [0.3333, 1, 0.6667, 1] };

const fields = [
  { type: 'group', key: 'gMedia', label: 'Media' },
  { key: 'media', type: 'media', label: 'Images / videos', slots: { from: 'media', max: 64 }, accept: 'media', ifFewer: 'reuse' },
  { type: 'group', key: 'gGrid', label: 'Grid' },
  { key: 'columns', type: 'range', label: 'Columns', default: 5, min: 1, max: 12, step: 1, integer: true },
  { key: 'rows', type: 'range', label: 'Rows', default: 5, min: 1, max: 12, step: 1, integer: true },
  { key: 'speed', type: 'range', label: 'Speed', default: 1, min: 0.25, max: 3, step: 0.05 },
  { key: 'cardScale', type: 'range', label: 'Card size', default: 1, min: 0.5, max: 1.6, step: 0.05 },
];

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const r6 = (v) => { const x = Math.round(v * 1e6) / 1e6; return Object.is(x, -0) ? 0 : x; };
const r4 = (v) => Math.round(v * 1e4) / 1e4;
const n = (v) => { const x = Number(v); return Math.abs(x) < 1e-12 ? '0' : String(Number(x.toPrecision(10))); };
const lerp = (a, b, t) => a + (b - a) * t;
function noise(x) { const y = Math.sin(x) * 10000; return y - Math.floor(y); }   // MotionFast's (mtl.js)

// a track through points [p, value] (p the clip's share of time), ease in-out cubic between them, held outside
function easedKeys(points, span, D) {
  const pos = (p) => r6(Math.max(0, Math.min(100, ((p * D) / span) * 100)));
  const out = [];
  const first = points[0], last = points[points.length - 1];
  if (first[0] > 0) out.push({ position: 0, value: first[1], easing: 'Linear' });
  for (let k = 0; k + 1 < points.length; k += 1) {
    const [p0, v0] = points[k], [p1, v1] = points[k + 1];
    if (Math.abs(v1 - v0) < 1e-12) { out.push({ position: pos(p0), value: v0, easing: 'Linear' }); continue; }
    out.push({ position: pos(p0), value: v0, ...EASE_IN_HALF });
    out.push({ position: pos((p0 + p1) / 2), value: (v0 + v1) / 2, ...EASE_OUT_HALF });
  }
  out.push({ position: pos(last[0]), value: last[1], easing: 'Linear' });
  if (last[0] < 1) out.push({ position: 100, value: last[1], easing: 'Linear' });
  const keys = out.filter((k, i) => i === 0 || k.position > out[i - 1].position);
  if (keys.every((k) => Math.abs(k.value - keys[0].value) < 1e-12)) return [{ position: 0, value: n(keys[0].value), easing: 'Linear' }];
  return keys.map((k) => ({ ...k, value: n(k.value) }));
}
// a value a + b·s(t) of the envelope: a at rest, a + b in the mosaic
const envKeys = (a, b, span, D) => easedKeys([[RISE[0], a], [RISE[1], a + b], [FALL[0], a + b], [FALL[1], a]], span, D);

export default {
  id: 'grid-3d-reveal',
  name: '3D Grid',
  category: 'Carousels',
  v: 1,
  fields,
  build({ settings: S, media, frame }) {
    const { W, H } = frame;
    const cols = Math.max(1, Math.round(num(S.columns, 5)));
    const rows = Math.max(1, Math.round(num(S.rows, 5)));
    const speed = Math.max(0.05, num(S.speed, 1) || 1);
    const D = Math.max(0.5, BASE_DURATION / speed);
    const span = r4(D);
    const N = cols * rows;
    const M = media.length;
    // MotionFast: the mosaic a bit wider than the frame, square spacing; cards as wide as the spacing × Card size
    const spacingPeak = (Math.max(W, H * 1.2) * 1.05) / Math.max(cols, rows);
    const cardSize = spacingPeak * (num(S.cardScale, 1) || 1);
    // the editor films the comp from its lens distance; MotionFast projects from 2400 px whatever the frame. A world
    // scaled by D/2400 about the centre, filmed through a camZoom of 2400/D, is MotionFast's picture
    const lens = (H * 0.5) / Math.tan(((LENS_FOV * Math.PI) / 180) * 0.5);
    const k = lens / PERSPECTIVE;
    const one = (v) => [{ position: 0, value: n(v), easing: 'Linear' }];

    const layers = [];
    layers.push({ key: 'swing', type: 'null', name: 'Swing', freeStart: 0, trimEnd: span,
      propertyKeyframes: { rotate: easedKeys(DUP_ROTZ_KEYS, span, D), scale: one(k) } });
    layers.push({ key: 'grid', type: 'null', name: 'Grid', freeStart: 0, trimEnd: span,
      keyframeParenting: { parentItemId: 'swing', type: 'additive' },
      propertyKeyframes: { rotateY: easedKeys(GRID_ROTY_KEYS.map(([p, v]) => [p, -v]), span, D) } });
    const cards = [];
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        const i = r * cols + c;
        cards.push({
          i, r, c,
          rotZ: lerp(-106, 168, noise(i * 7.13 + 0.31)) + (N > 1 ? lerp(-54, 70, i / (N - 1)) : 0),
          rotX: lerp(-30, 30, noise(i * 3.71 + 0.57)),
          rotY: lerp(-30, 30, noise(i * 5.39 + 0.11)),
          scl: lerp(-0.3, 0.3, noise(i * 9.17 + 0.73)),
        });
      }
    }
    // the slots: a card's place in the grid (spread by the envelope) and its turn about Y
    for (const cd of cards) {
      layers.push({ key: `slot[${cd.i}]`, type: 'null', name: `Slot ${cd.i + 1}`, freeStart: 0, trimEnd: span,
        keyframeParenting: { parentItemId: 'grid', type: 'additive' },
        propertyKeyframes: {
          xPercent: envKeys(0, ((cd.c - (cols - 1) / 2) * spacingPeak / W) * 100, span, D),
          yPercent: envKeys(0, ((cd.r - (rows - 1) / 2) * spacingPeak / H) * 100, span, D),
          rotateY: envKeys(0, -cd.rotY, span, D),
        } });
    }
    // the pictures, card 0 at the bottom (MotionFast draws level cards in index order); the list cycles into the cards,
    // with no media six example plates (a picture placed in example k shows on every sixth card, as six images would)
    const box = { w: r6(cardSize), h: r6(cardSize), fit: 'cover', radius: 0 };
    for (const cd of cards) {
      const slot = M ? cd.i % M : cd.i % 6;
      const plate = PLATES[cd.i % PLATES.length];
      const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(box.w)}" height="${Math.round(box.h)}"><rect width="100%" height="100%" fill="${plate}"/></svg>`)}`;
      const pic = M ? { type: media[slot].type === 'video' ? 'video' : 'image', media: slot } : { type: 'image', media: slot, src };
      layers.push({ ...pic, key: `card[${cd.i}]`, name: `Card ${cd.i + 1}`, box, freeStart: 0, trimEnd: span,
        keyframeParenting: { parentItemId: `slot[${cd.i}]`, type: 'additive' },
        propertyKeyframes: {
          rotateX: envKeys(0, cd.rotX, span, D),
          rotate: envKeys(0, cd.rotZ, span, D),
          scale: envKeys(1, cd.scl, span, D),
        } });
    }
    layers.push({ key: 'camera', type: 'camera', name: 'Lens', freeStart: 0, trimEnd: span,
      propertyKeyframes: { camZoom: one(PERSPECTIVE / lens) } });
    const warnings = [];
    if (M && media.some((x) => x.type === 'video')) warnings.push('A video on a card plays once (no loop yet).');
    return { duration: D, layers, warnings };
  },
};
