// Multi-angle diagnostic camera planner for 3D Scenes: pure math (no DOM, no React, no three dependency), safe in Node and browsers.
// Follows world3d's right-handed Y-up coordinate system and { at, target, up, fov } camera convention (inspect.js, lens.js).

const DEG = Math.PI / 180;

const DEFAULT_BOUNDS = Object.freeze({
  min: Object.freeze([-0.5, -0.5, -0.5]),
  max: Object.freeze([0.5, 0.5, 0.5]),
});

export const DIAGNOSTIC_VIEW_NAMES = Object.freeze([
  'hero',
  'front',
  'back',
  'side',
  'right',
  'left',
  'top',
  'bottom',
  'iso',
]);

function clean(x) {
  return x === 0 ? 0 : x;
}

function unit(v) {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [clean(v[0] / len), clean(v[1] / len), clean(v[2] / len)];
}

function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

const VIEW_SPECS = Object.freeze({
  front: { label: 'Front', dir: [0, 0, 1], up: [0, 1, 0] },
  back: { label: 'Back', dir: [0, 0, -1], up: [0, 1, 0] },
  side: { label: 'Side', dir: [1, 0, 0], up: [0, 1, 0] },
  right: { label: 'Right', dir: [1, 0, 0], up: [0, 1, 0] },
  left: { label: 'Left', dir: [-1, 0, 0], up: [0, 1, 0] },
  top: { label: 'Top', dir: [0, 1, 0], up: [0, 0, -1] },
  bottom: { label: 'Bottom', dir: [0, -1, 0], up: [0, 0, 1] },
  iso: { label: 'Iso', dir: unit([1, 0.75, 1]), up: [0, 1, 0] },
});

function normalizeBounds(bounds) {
  let lo = null;
  let hi = null;
  if (Array.isArray(bounds) && bounds.length === 2) {
    lo = bounds[0];
    hi = bounds[1];
  } else if (bounds && typeof bounds === 'object') {
    lo = bounds.min;
    hi = bounds.max;
  }
  if (!Array.isArray(lo) || !Array.isArray(hi) || lo.length < 3 || hi.length < 3) {
    return DEFAULT_BOUNDS;
  }
  const min = [Number(lo[0]), Number(lo[1]), Number(lo[2])];
  const max = [Number(hi[0]), Number(hi[1]), Number(hi[2])];
  for (let k = 0; k < 3; k += 1) {
    if (!Number.isFinite(min[k]) || !Number.isFinite(max[k]) || min[k] > max[k]) {
      return DEFAULT_BOUNDS;
    }
  }
  const dx = max[0] - min[0];
  const dy = max[1] - min[1];
  const dz = max[2] - min[2];
  if (dx <= 1e-9 && dy <= 1e-9 && dz <= 1e-9) {
    return DEFAULT_BOUNDS;
  }
  return { min, max };
}

function frameView(box, spec, viewName, { fov, margin, aspect }) {
  const center = [
    clean((box.min[0] + box.max[0]) / 2),
    clean((box.min[1] + box.max[1]) / 2),
    clean((box.min[2] + box.max[2]) / 2),
  ];
  const hx = (box.max[0] - box.min[0]) / 2;
  const hy = (box.max[1] - box.min[1]) / 2;
  const hz = (box.max[2] - box.min[2]) / 2;
  const maxSpan = Math.max(hx, hy, hz) * 2;

  const dir = spec.dir;
  const up = spec.up;
  const forward = [-dir[0], -dir[1], -dir[2]];
  const right = unit(cross(forward, up));
  const camUp = unit(cross(right, forward));

  const tanV = Math.tan((fov * DEG) / 2);
  const tanH = tanV * aspect;
  const nearFloor = Math.max(0.05, maxSpan * 0.05);

  // Project all 8 box corners into camera basis so both vertical and horizontal FOV fit the full box with `margin`.
  let distance = nearFloor;
  for (let c = 0; c < 8; c += 1) {
    const dx = c & 1 ? hx : -hx;
    const dy = c & 2 ? hy : -hy;
    const dz = c & 4 ? hz : -hz;
    const cx = dx * right[0] + dy * right[1] + dz * right[2];
    const cy = dx * camUp[0] + dy * camUp[1] + dz * camUp[2];
    const cz = dx * forward[0] + dy * forward[1] + dz * forward[2];
    const reqV = (margin * Math.abs(cy)) / tanV - cz;
    const reqH = (margin * Math.abs(cx)) / tanH - cz;
    const reqNear = nearFloor - cz;
    if (reqV > distance) distance = reqV;
    if (reqH > distance) distance = reqH;
    if (reqNear > distance) distance = reqNear;
  }

  const at = [
    clean(center[0] + dir[0] * distance),
    clean(center[1] + dir[1] * distance),
    clean(center[2] + dir[2] * distance),
  ];
  const camUpClean = up.map(clean);
  const camera = { at, target: [...center], up: camUpClean, fov };
  const override = { at: [...at], target: [...center], up: [...camUpClean], fov };
  return { view: viewName, label: spec.label, override, camera };
}

/**
 * Plan diagnostic camera views around an axis-aligned bounding box `bounds` (`{ min: [x,y,z], max: [x,y,z] }`).
 *
 * Returns `[{ view, label, override, camera }]`, where `hero` preserves `heroCamera` unchanged with `override: null`,
 * and every other view places a perspective camera looking at the box center from a tight framing distance covering
 * all 8 corners across both vertical (`fov`) and horizontal (`fov`, `aspect`) frustum bounds with `margin`.
 */
export function planDiagnosticViews(
  bounds,
  heroCamera = null,
  views = ['hero', 'front', 'side', 'top'],
  { fov = 32, margin = 1.25, aspect = 16 / 9 } = {},
) {
  const viewList = views === null || views === undefined ? ['hero', 'front', 'side', 'top'] : views;
  if (!Array.isArray(viewList)) {
    throw new TypeError(`views must be an array of diagnostic view names (expected one of: ${DIAGNOSTIC_VIEW_NAMES.join(', ')})`);
  }

  const effFov = Number.isFinite(fov) && fov > 0 ? Math.min(170, Math.max(1, fov)) : 32;
  const effMargin = Number.isFinite(margin) && margin > 0 ? margin : 1.25;
  const effAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
  const box = normalizeBounds(bounds);

  return viewList.map((raw) => {
    const key = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (!DIAGNOSTIC_VIEW_NAMES.includes(key)) {
      throw new Error(`Unknown diagnostic view "${String(raw)}" (expected one of: ${DIAGNOSTIC_VIEW_NAMES.join(', ')})`);
    }
    if (key === 'hero') {
      return {
        view: 'hero',
        label: 'Hero',
        override: null,
        camera: heroCamera ?? null,
      };
    }
    return frameView(box, VIEW_SPECS[key], key, { fov: effFov, margin: effMargin, aspect: effAspect });
  });
}

// A set piece's longest side is more than SET_SCALE times the longest side of each object it dwarfs; a plane's thinnest side is at most
// PLANE_THIN of its longest.
const SET_SCALE = 2;
const PLANE_THIN = 0.1;

function boxOf(list) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const o of list) {
    for (let k = 0; k < 3; k += 1) {
      min[k] = Math.min(min[k], o.min[k]);
      max[k] = Math.max(max[k], o.max[k]);
    }
  }
  return { min, max };
}

const sidesOf = (b) => [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];

function holds(outer, inner) {
  const slack = 0.01 * Math.hypot(...sidesOf(outer));
  for (let k = 0; k < 3; k += 1) if (inner.min[k] < outer.min[k] - slack || inner.max[k] > outer.max[k] + slack) return false;
  return true;
}

function isSetPiece(o, all) {
  const sides = sidesOf(o);
  const longest = Math.max(...sides);
  const dwarfed = all.filter((x) => x !== o && SET_SCALE * Math.max(...sidesOf(x)) < longest);
  if (!dwarfed.length) return false;
  return Math.min(...sides) <= PLANE_THIN * longest || holds(o, boxOf(dwarfed));
}

/**
 * The box the diagnostic views frame (`{ min, max, ids }`, or null when no object has a box), from inspect's objects
 * (`[{ id, bbox: { min, max } }]`):
 * - `named` (render-still `objects`): those objects, when any of them has a box;
 * - otherwise every object but the Rig's `backdrop`, the world's own (`~` ids) and those `hidden` at this time (their `visible` keys),
 *   and without the set pieces: an object that dwarfs others (its longest side more than twice theirs) AND is a plane (a floor, a wall,
 *   a ground: its thinnest side at most a tenth of its longest) or holds all those it dwarfs inside its box (a room). A big object that
 *   is neither (a tree by a bench) stays, and so does one that dwarfs nothing.
 * When that leaves nothing, every object with a box.
 */
export function subjectBounds(objects, { named = null, hidden = null } = {}) {
  const boxed = [];
  for (const o of Array.isArray(objects) ? objects : []) {
    const lo = o?.bbox?.min;
    const hi = o?.bbox?.max;
    if (!Array.isArray(lo) || !Array.isArray(hi) || lo.length < 3 || hi.length < 3) continue;
    const min = [Number(lo[0]), Number(lo[1]), Number(lo[2])];
    const max = [Number(hi[0]), Number(hi[1]), Number(hi[2])];
    if ([...min, ...max].every(Number.isFinite) && min.every((v, k) => v <= max[k])) boxed.push({ id: String(o.id), min, max });
  }
  if (!boxed.length) return null;
  const pick = (list) => ({ ...boxOf(list), ids: list.map((o) => o.id) });
  const names = new Set((Array.isArray(named) ? named : []).map(String));
  if (names.size) {
    const chosen = boxed.filter((o) => names.has(o.id));
    if (chosen.length) return pick(chosen);
  }
  const off = new Set((hidden || []).map(String));
  const shown = boxed.filter((o) => o.id !== 'backdrop' && !o.id.startsWith('~') && !off.has(o.id));
  const keep = shown.filter((o) => !isSetPiece(o, shown));
  return pick(keep.length ? keep : boxed);
}

/**
 * Draws each planned view (planDiagnosticViews): `setView(override)`, then `capture(entry)`, whose fields join the view's entry. The hero
 * is not drawn again (`hero: true`: the still is its picture). `setView(null)` runs last whatever happens, so no diagnostic camera
 * outlives the views. A failure ends the views and comes back as `error` beside the views drawn before it, unless `fatal(error)` says
 * the caller must get it (a lost GPU context: the page must not be used again).
 */
export async function captureDiagnosticViews(planned, { setView, capture, fatal = () => false }) {
  const views = [];
  try {
    for (const entry of planned) {
      if (!entry.override) {
        views.push({ view: entry.view, label: entry.label, hero: true });
        continue;
      }
      setView(entry.override);
      views.push({ view: entry.view, label: entry.label, ...(await capture(entry)) });
    }
    return { views, error: null };
  } catch (e) {
    if (fatal(e)) throw e;
    return { views, error: String(e?.message || e) };
  } finally {
    setView(null);
  }
}
