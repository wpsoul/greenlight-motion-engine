/*
 * (mblur5) 3D Text letters across a motion-blur shutter.
 *
 * A Text Animator moves a 3D Text layer's letters inside a frame's shutter. The world takes them as it takes any object that moves there:
 * the layer's letters laid out at each of the shutter's times (world3dLayer.js worldMotionBlur / worldDraftBlur, through channelRender.js
 * text3dRunAt), handed to it at each time (WorldRenderer.setLetters), and each letter's mesh is captured at each pose. The world keeps one
 * mesh per letter by its place in the layer's list (render/letters.js), so every time must hand the same letters in the same order. Here the
 * times' lists are lined up: each letter by its name (world3dText.js worldTextLetters `key`), in the frame's own order, a letter shown at only
 * some of the times added (where it is not shown, it stands shrunk to nothing where it is next seen: the shutter's share without it).
 *
 * A letter at scale 0 (a Text Animator's Scale from 0: a word that grows in) cannot be a pose the trace moves from: the trace moves each
 * object from its pose in the frame's middle by the change to each step's (W_k W_c^-1), and a matrix without an inverse has no change. A
 * letter shrunk to nothing at one of the times stands there SHRINK times its largest pose instead (turned as that pose, at its own place):
 * a hundredth of a millimetre on a 4 cm letter, under a pixel, and a pose the trace can move from and to.
 *
 * What the trace cannot take is refused (an Error, and the caller renders the frame as sub-frames): a layer that comes or goes inside the
 * shutter. A letter that wears a Scene material (`finish.material`) is drawn in that material whatever its colour or opacity, so its colours
 * are not compared.
 *
 * (mblur6) A letter that fades or changes colour inside the shutter (an Opacity or Fill animator, a letter typed in) is traced too: `looks`
 * 'tint' (Final's trace) hands every time the letter's brightest look (each channel's most, its most opacity) and each time a `tint`, its
 * own colour and opacity over that look ([r, g, b, a], linear light): the trace multiplies the letter's paint by the tint at each sample's
 * time (WorldRenderer.captureMotion's tints, the tracer's per-object tint table: tracerMotion.js mbTint). A plastic letter shown at only
 * some of the times stands where it is next seen with opacity 0 where it is not shown, so it fades in or out over the step where it comes
 * or goes instead of popping (before: shrunk to nothing). `looks` 'own' (Draft, which draws each time as a picture) hands every time its
 * own look. Glass letters that fade or change colour, and caps and sides that change colour apart, are still refused.
 *
 * Every time hands the frame's own letter but its matrix: its glyph, its `unit` (text3dgaps: the glyph built in metres at the letter's
 * font size, the matrix taking that scale back, render/letters.js) and its look. One glyph and one size for the whole shutter, so each
 * letter is one mesh that moves (a font size keyed under the shutter still draws each time at its own size: the matrix carries it).
 *
 * Pure: node tests (shutterLetters.test.mjs).
 */

/** How small a letter at scale 0 stands, against its largest pose in the shutter. */
export const SHRINK = 1e-3;

const column = (m, c) => Math.hypot(m[4 * c], m[4 * c + 1], m[4 * c + 2]);
const det3 = (m) => m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);

/** Whether a letter's matrix (column-major) is no pose to move from: an axis shrunk to (nearly) nothing (a tenth of SHRINK) next to `size`,
 *  its largest axis in the shutter, or its axes in one plane. */
export function flatPose(m, size) {
  const a = column(m, 0), b = column(m, 1), c = column(m, 2);
  if (!(Math.min(a, b, c) > 0.1 * SHRINK * size)) return true;
  return !(Math.abs(det3(m)) > 1e-6 * a * b * c);
}

/** `ref`'s turn and scale times SHRINK, at `at`'s place (column-major). */
const shrunk = (ref, at) => ref.map((v, i) => (i < 12 ? (i % 4 === 3 ? 0 : v * SHRINK) : at[i]));

/**
 * The letters of every 3D Text layer the world takes, lined up across a shutter. `frames`: one Map(layer id -> layer) a time (the layer as
 * world3dText.js worldTextLetters makes it: { finish, letters: [{ key, glyph, matrix, unit, face, side, shade, opacity }], glyph }), in the order
 * of their times; `center` the index of the frame's own time. Returns the same list of Maps, each layer with the same letters in the same
 * order (the frame's own finish on all of them), or throws an Error that says why the trace cannot take them.
 */
export function alignShutterLetters(frames, center = 0, { looks = 'tint' } = {}) {
  const own = frames[center];
  if (!own) throw new Error('letters: no frame');
  const ids = [...own.keys()];
  for (const f of frames) {
    if (f.size !== own.size || ids.some((id) => !f.has(id))) throw new Error('letters: a 3D Text layer starts or ends inside the shutter');
  }
  const out = frames.map(() => new Map());
  for (const id of ids) {
    const base = own.get(id);
    const dressed = !!base.finish?.material;
    // every letter's name, the frame's own first, then the ones only other times show, as they come
    const names = [];
    const known = new Set();
    for (const f of [own, ...frames]) for (const l of f.get(id).letters) if (!known.has(l.key)) { known.add(l.key); names.push(l.key); }
    const byName = frames.map((f) => new Map(f.get(id).letters.map((l) => [l.key, l])));
    const rows = names.map((name) => {
      const at = byName.map((m) => m.get(name) || null);
      const shown = at.filter(Boolean);
      const first = at[center] || shown[0];
      if (shown.some((l) => l.glyph !== first.glyph)) throw new Error('letters: a letter changes its glyph inside the shutter');
      // (mblur6) its look at each time: the same all through, or (a plastic letter) a fade or a change of colour the trace takes as a tint
      const changes = !dressed && shown.some((l) => l.face !== first.face || l.side !== first.side || l.shade !== first.shade || Math.abs((l.opacity ?? 1) - (first.opacity ?? 1)) > 1e-4);
      const fades = !dressed && (changes || shown.length < at.length);
      if (changes && base.finish?.glass) throw new Error('letters: a glass letter fades or changes colour inside the shutter');
      // its poses: where it is shown, else where it is next seen (the nearer time, the earlier on a tie): (mblur6) a plastic letter there with
      // opacity 0, a letter in a Scene material (which shows whatever its opacity) shrunk to nothing; a pose at scale 0 shrunk
      const size = Math.max(0, ...shown.map((l) => Math.max(column(l.matrix, 0), column(l.matrix, 1), column(l.matrix, 2))));
      const solid = shown.filter((l) => !flatPose(l.matrix, size));
      const ref = solid.length ? solid.reduce((a, b) => (Math.abs(det3(b.matrix)) > Math.abs(det3(a.matrix)) ? b : a)).matrix : null;
      const nearest = (k) => {
        for (let d = 1; d < at.length; d += 1) {
          if (at[k - d]) return at[k - d];
          if (at[k + d]) return at[k + d];
        }
        return first;
      };
      const own = at.map((l, k) => (l ? l.matrix : nearest(k).matrix));
      // never a pose to move from: nothing of it shows in the shutter, so it holds the frame's own (or first) place, still
      const poses = ref ? own.map((m, k) => ((at[k] || fades) && !flatPose(m, size) ? m : shrunk(ref, m))) : own.map(() => first.matrix);
      const look = fades ? shutterLooks(at, first, looks) : null;
      return { first, poses, look };
    });
    frames.forEach((_, k) => {
      out[k].set(id, { ...base, letters: rows.map(({ first, poses, look }) => ({ ...first, ...(look ? look[k] : {}), matrix: poses[k] })) });
    });
  }
  return out;
}

/** (mblur6) A CSS colour (`#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()` / `rgba()`, as the 3D pass and the Text Animators write them) as its
 *  three sRGB bytes, or null for one this cannot read. */
export function cssBytes(css) {
  const s = String(css ?? '').trim();
  let m = s.match(/^#([0-9a-f]{3,8})$/i);
  if (m) {
    const h = m[1];
    if (h.length === 3 || h.length === 4) return [0, 1, 2].map((i) => parseInt(h[i] + h[i], 16));
    if (h.length === 6 || h.length === 8) return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    return null;
  }
  m = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*[\d.]+\s*)?\)$/i);
  return m ? [m[1], m[2], m[3]].map((v) => Math.min(255, parseInt(v, 10))) : null;
}

/** sRGB byte to linear light, as three's SRGBToLinear takes a colour the world paints from a CSS string. */
const linear = (b) => { const c = b / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const hex = (bytes) => `#${bytes.map((b) => b.toString(16).padStart(2, '0')).join('')}`;

/**
 * (mblur6) A plastic letter's look at each time of a shutter where it fades, changes colour, or shows at some times only (`at`: its letter at
 * each time, null where it is not shown; `first` the frame's own). 'own': each time its own face, side, shade and opacity (0 where it is not
 * shown). 'tint': each time the letter's brightest look (its face's and side's most of each channel over the times, as sRGB bytes, so the
 * world paints exactly that; its most opacity) and `tint` [r, g, b, a]: its own colour and opacity over that look, in linear light; `see`
 * when it is see-through at some time (the trace then reads its opacity). Throws for a colour this cannot read, a Side Shade that changes,
 * or caps and sides whose colours change apart (one tint takes both).
 */
function shutterLooks(at, first, looks) {
  if (looks === 'own') return at.map((l) => (l ? { face: l.face, side: l.side, shade: l.shade, opacity: l.opacity ?? 1 } : { opacity: 0 }));
  const shown = at.filter(Boolean);
  if (shown.some((l) => l.shade !== first.shade || (l.side == null) !== (first.side == null))) throw new Error('letters: a letter changes its side colour inside the shutter');
  const read = (css) => { const b = cssBytes(css); if (!b) throw new Error(`letters: a letter's colour ${css} cannot be traced as a fade`); return b; };
  const faces = at.map((l) => (l ? read(l.face) : null)), sides = first.side == null ? null : at.map((l) => (l ? read(l.side) : null));
  const most = (list) => [0, 1, 2].map((c) => Math.max(...list.filter(Boolean).map((b) => b[c])));
  const faceMost = most(faces), sideMost = sides ? most(sides) : null;
  const opMost = Math.max(...shown.map((l) => l.opacity ?? 1));
  const ratio = (b, top) => b.map((v, c) => (top[c] > 0 ? linear(v) / linear(top[c]) : 1));
  const tints = at.map((l, k) => {
    // where it is not shown: the colour of the time it is next seen, and no opacity
    let j = k;
    for (let d = 1; !at[j] && d < at.length; d += 1) j = at[k - d] ? k - d : at[k + d] ? k + d : j;
    const rgb = ratio(faces[j], faceMost);
    if (sides) {
      const s = ratio(sides[j], sideMost);
      if (s.some((v, c) => Math.abs(v - rgb[c]) > 2e-3 * Math.max(1, v))) throw new Error('letters: a letter\'s caps and sides change colour apart inside the shutter');
    }
    return [...rgb, l ? (opMost > 0 ? (l.opacity ?? 1) / opMost : 0) : 0];
  });
  const see = tints.some((t) => t[3] < 1 - 1e-4);
  const look = { face: hex(faceMost), side: sideMost ? hex(sideMost) : null, shade: first.shade, opacity: opMost, see };
  return tints.map((tint) => ({ ...look, tint }));
}
