// Text on Path — Corners. 'smooth' (the default) turns every letter with the curve, so a letter that sits on a
// tight bend takes an in-between angle and its neighbours crowd into each other there. 'sharp' treats bends as
// corners: a letter never straddles one. It belongs wholly to ONE side — turned to that side's direction and laid on
// that side's straight line, carried on through the bend. The side is the one the letter RESTS on (Path Progress 0),
// so a short glide or drift never turns a letter at a corner; only a letter carried more than half its own width
// from its rest changes sides, when its centre passes the middle of the bend (a marquee round a square).
// Pure (no engine imports) so the node tests reach it.

export const TEXT_PATH_CORNER_MODES = ['smooth', 'sharp'];

// A bend counts as a corner when the path turns at least this much across the window around a letter.
export const SHARP_CORNER_MIN_TURN = (20 * Math.PI) / 180;

export const normalizeTextPathCorners = (value) => (value === 'sharp' ? 'sharp' : 'smooth');

const wrap = (a) => {
  let v = a;
  while (v > Math.PI) v -= 2 * Math.PI;
  while (v < -Math.PI) v += 2 * Math.PI;
  return v;
};

/**
 * The pose of one letter under 'sharp' corners.
 * @param {(arc:number) => ({x:number, y:number, tang:number} | null)} sample — the point and tangent direction at an
 *   arc length (world space, +y up; `tang` = atan2(tangent.y, tangent.x)).
 * @param {number} arc — the letter centre's arc length.
 * @param {number} reach — how far either side to look for the straight sides: at least half the letter's width,
 *   and more than a rounded corner's arc so both ends land on straight path.
 * @param {number} [homeArc] — where the letter's centre rests (Path Progress 0); defaults to `arc`.
 * @param {number} [stick] — how far from its rest a letter keeps its resting side (half its width).
 * @returns {{x:number, y:number, tang:number} | null} the letter centre and the direction it is turned to.
 */
export function sharpCornerPose(sample, arc, reach, homeArc = arc, stick = 0) {
  const mid = sample(arc);
  if (!mid || !(reach > 0)) return mid;
  const a = sample(arc - reach);
  const b = sample(arc + reach);
  if (!a || !b) return mid;
  if (Math.abs(wrap(b.tang - a.tang)) < SHARP_CORNER_MIN_TURN) return mid;
  // Which side: the one whose direction the letter's RESTING tangent is closer to — while it is within `stick` of its
  // rest — else the one its centre is on now.
  const home = homeArc !== arc && Math.abs(arc - homeArc) <= stick ? sample(homeArc) : null;
  const ref = home || mid;
  if (Math.abs(wrap(ref.tang - a.tang)) <= Math.abs(wrap(ref.tang - b.tang))) {
    // The incoming side, carried on straight from `a` for `reach`.
    return { x: a.x + Math.cos(a.tang) * reach, y: a.y + Math.sin(a.tang) * reach, tang: a.tang };
  }
  // The outgoing side, carried back straight from `b`.
  return { x: b.x - Math.cos(b.tang) * reach, y: b.y - Math.sin(b.tang) * reach, tang: b.tang };
}
