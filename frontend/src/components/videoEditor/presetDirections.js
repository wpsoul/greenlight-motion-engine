/*
 * Directional keyframe presets (2026-10-16, the owner: "one Glide, then choose the direction" — instead of a Left,
 * a Right, an Up and a Down preset with the same motion). A preset is authored travelling ONE way (`baseDir`) and says
 * which directions it offers (`directions: 'cardinal' | 'diagonal'`); the presets modal's Direction pad picks one and
 * directedKeyframes() re-maps the preset's own keys into it:
 *
 *   xPercent / yPercent and translateX / translateY   by the direction's 2×2 map (swap and / or sign, never a mix)
 *   rotate                                           negated when the map mirrors (a bank or a spin leans the other way)
 *   rotateY / rotateX                                as a pair, like x / y (a 3D swing turns on the other axis for
 *                                                     vertical travel)
 *   the ƒx map                                        its keys follow their tracks
 *
 * A direction is where the layer TRAVELS: 'left' comes in from the right and leaves on the left.
 * Pure and dependency-free (node --test loads it).
 */

export const CARDINAL = ['left', 'right', 'up', 'down'];
export const DIAGONAL = ['upLeft', 'upRight', 'downLeft', 'downRight'];
export const DIRECTION_LABEL = {
  left: 'Left', right: 'Right', up: 'Up', down: 'Down',
  upLeft: 'Up-Left', upRight: 'Up-Right', downLeft: 'Down-Left', downRight: 'Down-Right',
};
// screen space: x right, y down
export const DIRECTION_VECTOR = {
  left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1],
  upLeft: [-1, -1], upRight: [1, -1], downLeft: [-1, 1], downRight: [1, 1],
};
const OPPOSITE = { left: 'right', right: 'left', up: 'down', down: 'up', upLeft: 'downRight', downRight: 'upLeft', upRight: 'downLeft', downLeft: 'upRight' };

// Each direction's map FROM its family's canonical direction ('left' / 'upLeft'), as [[a, b], [c, d]]:
// x' = a·x + b·y, y' = c·x + d·y. Signed permutations only, so a track never mixes into another.
const FROM_CANONICAL = {
  left: [[1, 0], [0, 1]],
  right: [[-1, 0], [0, 1]],        // mirrored: the arc still bulges up
  up: [[0, 1], [1, 0]],            // x travel becomes y travel (start 100 = bottom → −150 = top)
  down: [[0, 1], [-1, 0]],         // start 100 → −100 (top), end −150 → 150 (bottom)
  upLeft: [[1, 0], [0, 1]],
  upRight: [[-1, 0], [0, 1]],
  downLeft: [[1, 0], [0, -1]],
  downRight: [[-1, 0], [0, -1]],
};
const PAIRS = [['xPercent', 'yPercent'], ['translateX', 'translateY'], ['rotateY', 'rotateX']];

export function directionsOf(preset) {
  if (!preset?.directions) return null;
  return preset.directions === 'diagonal' ? DIAGONAL : CARDINAL;
}

const transpose = ([[a, b], [c, d]]) => [[a, c], [b, d]];
const mul = ([[a, b], [c, d]], [[e, f], [g, h]]) => [[a * e + b * g, a * f + b * h], [c * e + d * g, c * f + d * h]];
const det = ([[a, b], [c, d]]) => a * d - b * c;

/** The 2×2 map that turns a preset authored travelling `baseDir` into one travelling `dir`. */
export function directionMap(baseDir, dir) {
  const base = FROM_CANONICAL[baseDir];
  const target = FROM_CANONICAL[dir];
  if (!base || !target) return [[1, 0], [0, 1]];
  // back to the canonical direction (an orthogonal map's inverse is its transpose), then out to the target
  return mul(target, transpose(base));
}

const num = (v) => Number.parseFloat(v);
const fmt = (v) => {
  const r = Math.round(v * 1e4) / 1e4;
  return String(Object.is(r, -0) ? 0 : r);
};

function mapProperties(props, M) {
  const out = { ...props };
  for (const [px, py] of PAIRS) {
    const hasX = props[px] != null && props[px] !== '';
    const hasY = props[py] != null && props[py] !== '';
    if (!hasX && !hasY) continue;
    delete out[px];
    delete out[py];
    const x = hasX ? num(props[px]) : 0;
    const y = hasY ? num(props[py]) : 0;
    // a signed permutation: each output reads exactly one input, so a missing input stays missing
    const [[a, b], [c, d]] = M;
    if ((a !== 0 && hasX) || (b !== 0 && hasY)) out[px] = fmt(a * x + b * y);
    if ((c !== 0 && hasX) || (d !== 0 && hasY)) out[py] = fmt(c * x + d * y);
  }
  if (det(M) < 0 && props.rotate != null && props.rotate !== '') out.rotate = fmt(-num(props.rotate));
  return out;
}

function mapFx(fx, M) {
  if (!fx) return fx;
  const out = { ...fx };
  for (const [px, py] of PAIRS) {
    if (!(px in fx) && !(py in fx)) continue;
    delete out[px];
    delete out[py];
    const [[a, b], [c, d]] = M;
    if (a !== 0 && fx[px]) out[px] = fx[px];
    if (b !== 0 && fx[py]) out[px] = fx[py];
    if (c !== 0 && fx[px]) out[py] = fx[px];
    if (d !== 0 && fx[py]) out[py] = fx[py];
  }
  return out;
}

/** The preset's keyframes + ƒx travelling `dir` (a non-directional preset, or an unknown dir, comes back as it is). */
export function directedKeyframes(preset, dir) {
  const allowed = directionsOf(preset);
  if (!allowed || !allowed.includes(dir) || dir === preset.baseDir) return { keyframes: preset.keyframes, fx: preset.fx || null };
  const M = directionMap(preset.baseDir, dir);
  return {
    keyframes: preset.keyframes.map((kf) => ({ ...kf, properties: mapProperties(kf.properties || {}, M) })),
    fx: mapFx(preset.fx || null, M),
  };
}

export const oppositeDirection = (dir) => OPPOSITE[dir] || dir;

/** The direction a pad point (−1…1 from the centre, y down) means, among `allowed`. */
export function nearestDirection(x, y, allowed) {
  let best = allowed[0];
  let bestDot = -Infinity;
  const len = Math.hypot(x, y) || 1;
  for (const d of allowed) {
    const [vx, vy] = DIRECTION_VECTOR[d];
    const dot = (x * vx + y * vy) / (len * Math.hypot(vx, vy));
    if (dot > bestDot) { bestDot = dot; best = d; }
  }
  return best;
}
