/*
 * Camera Rig — a parametric camera move, evaluated straight to a pose.
 *
 * A LEAF module (no editor imports), look-dev'd in html/camera-rig-lab.html; the
 * maths here is that lab's `BUILDERS` block verbatim.
 *
 * THE DESIGN DECISION THAT SHAPES THIS FILE: a rig owns no path and writes none.
 *
 * The camera has three mutually exclusive movement modes (item.cameraMoveMode):
 *
 *   free   position/rotation keyframes only — what a camera has always done
 *   path   the hand-drawn Motion Path panel; camPathT is progress along it
 *   rig    this module; camPathT is progress through the parametric move
 *
 * An earlier design had the rig REGENERATE item.cameraPath.points on every
 * parameter change. That meant a rig edit silently destroyed a user's hand-drawn
 * path, and the only defence was a `live`/detach flag they had to understand.
 * Evaluating instead means there is nothing to overwrite: switch rig → path and the
 * drawn curve is exactly as it was left. It also removes any need for the inverse
 * ("rigFromPath"), because nothing was ever baked.
 *
 * World convention matches the editor: +X right, +Y DOWN, +Z toward the viewer,
 * subject at the origin.
 */

const D2R = Math.PI / 180;

// 'smartZoom' is the Zoom tab (smartZoomCamera.js): zoom ranges on the camera layer, automatic from a screen
// recording's clicks or placed by hand. Its stored id keeps the name the first recordings were saved with.
export const CAMERA_MOVE_MODES = ['free', 'path', 'rig', 'smartZoom'];
export const CAMERA_MOVE_MODE_LABELS = {
  free: 'Free',
  path: 'Motion Path',
  rig: 'Camera Rig',
  smartZoom: 'Zoom',
};
const STORED_MOVE_MODES = CAMERA_MOVE_MODES;

export const CAMERA_RIG_TYPES = ['orbit', 'dolly', 'crane', 'pushIn', 'truck', 'spiral', 'handheld', 'follow'];

export const CAMERA_RIG_TYPE_LABELS = {
  orbit: 'Orbit', dolly: 'Dolly', crane: 'Crane', pushIn: 'Push In',
  truck: 'Truck', spiral: 'Spiral', handheld: 'Handheld', follow: 'Follow Object',
};

// Which parameters each type actually reads. The panel DISABLES the rest rather
// than hiding them, so switching type doesn't make the controls jump around.
export const CAMERA_RIG_PARAMS = {
  orbit: ['radius', 'height', 'startAngle', 'sweep', 'tilt', 'roll'],
  dolly: ['radius', 'height', 'startAngle', 'distance', 'tilt', 'roll'],
  crane: ['radius', 'height', 'startAngle', 'sweep', 'rise', 'tilt', 'roll'],
  pushIn: ['radius', 'height', 'startAngle', 'distance', 'tilt', 'roll'],
  truck: ['radius', 'height', 'startAngle', 'distance', 'tilt', 'roll'],
  spiral: ['radius', 'height', 'startAngle', 'sweep', 'rise', 'turns', 'tilt', 'roll'],
  handheld: ['radius', 'height', 'startAngle', 'amplitude', 'frequency', 'tilt', 'roll'],
  follow: ['radius', 'height', 'startAngle', 'sweep', 'tilt', 'roll'],
};

export const CAMERA_RIG_PARAM_META = {
  radius: { label: 'Radius', min: 100, max: 20000, step: 10, suffix: 'px' },
  height: { label: 'Height', min: -8000, max: 8000, step: 10, suffix: 'px' },
  startAngle: { label: 'Start', min: -360, max: 360, step: 1, suffix: '°' },
  sweep: { label: 'Sweep', min: -720, max: 720, step: 1, suffix: '°' },
  rise: { label: 'Rise', min: -8000, max: 8000, step: 10, suffix: 'px' },
  distance: { label: 'Travel', min: -20000, max: 20000, step: 10, suffix: 'px' },
  turns: { label: 'Turns', min: 0.25, max: 8, step: 0.25, suffix: '×' },
  tilt: { label: 'Tilt', min: -80, max: 80, step: 1, suffix: '°' },
  roll: { label: 'Roll', min: -180, max: 180, step: 1, suffix: '°' },
  amplitude: { label: 'Amount', min: 0, max: 2000, step: 5, suffix: 'px' },
  frequency: { label: 'Rate', min: 0, max: 40, step: 0.5, suffix: '×' },
};

// Where the camera looks while the rig moves it. `center` aims at the point the
// rig is built around (the comp centre, or the followed layer for Follow Object);
// `path` faces along the move itself — the camera looks where it is travelling,
// like After Effects' Orient Along Path. A choice, not a number, so it sits beside
// `type` rather than in CAMERA_RIG_PARAM_META.
export const CAMERA_RIG_AIMS = ['center', 'path'];
export const CAMERA_RIG_AIM_LABELS = { center: 'Center', path: 'Path align' };

export const CAMERA_RIG_DEFAULTS = Object.freeze({
  type: 'orbit',
  aim: 'center',
  radius: 1800, height: 400,
  startAngle: -40, sweep: 90,
  rise: 0, tilt: -8, roll: 0,
  distance: 1200, turns: 1,
  amplitude: 0, frequency: 0,
  seed: 7,
});

function num(value, fallback, min, max) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (Number.isFinite(min) && n < min) return min;
  if (Number.isFinite(max) && n > max) return max;
  return n;
}

/**
 * Materialise a complete, finite rig from anything the editor or an older project
 * can hand us. This is deliberately shared by the panel, evaluator and endpoint
 * solver: spreading a malformed saved value over the defaults lets `undefined`
 * win, and one bad field then turns the whole camera pose into NaN.
 */
export function normalizeCameraRig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const D = CAMERA_RIG_DEFAULTS;
  const out = { type: CAMERA_RIG_TYPES.includes(source.type) ? source.type : D.type };
  out.aim = CAMERA_RIG_AIMS.includes(source.aim) ? source.aim : D.aim;
  for (const [key, meta] of Object.entries(CAMERA_RIG_PARAM_META)) {
    out[key] = num(source[key], D[key], meta.min, meta.max);
  }
  out.seed = Math.round(num(source.seed, D.seed, 0, 100000));
  // Follow Object's hand-off list — layer item ids, in order. Carried HERE because
  // the panel round-trips every edit through this normalizer; treating it as an
  // unknown key would silently empty the list on the first radius nudge. Always a
  // fresh array: the defaults are frozen and shared, so a mutable array there
  // would alias one list across every camera clip.
  out.targets = Array.isArray(source.targets)
    ? source.targets.filter((id) => typeof id === 'string' && id).slice(0, 50)
    : [];
  return out;
}

/** Strict sanitizer. Same spread contract as the other optional item blocks: `{}`
 *  for an item that carries no rig, so every other camera keeps its saved shape. */
export function sanitizeCameraRig(item) {
  const raw = item?.cameraRig;
  if (!raw || typeof raw !== 'object') return {};
  return { cameraRig: normalizeCameraRig(raw) };
}

export function sanitizeCameraMoveMode(value) {
  return STORED_MOVE_MODES.includes(value) ? value : 'free';
}

// Deterministic value noise. NEVER Math.random() or wall-clock — a handheld move
// has to be a pure function of the playhead or preview and export diverge, the same
// discipline the seeded textRandom* fields use.
function noiseCell(seed, cell) {
  const s = Math.sin(cell * 127.1 + seed * 311.7) * 43758.5453123;
  return (s - Math.floor(s)) * 2 - 1;
}

// Interpolating fixed lattice values makes the motion continuous. The previous
// implementation hashed the floating sample itself, so even adjacent frames jumped
// to unrelated values and a low Rate still looked like fast vibration.
function smoothNoise(seed, x) {
  const cell = Math.floor(x);
  const f = x - cell;
  const eased = f * f * f * (f * (f * 6 - 15) + 10);
  return noiseCell(seed, cell) * (1 - eased) + noiseCell(seed, cell + 1) * eased;
}

// Two smooth octaves reads as a hand rather than a mechanical sine wobble.
const drift = (seed, x) => smoothNoise(seed, x) * 0.65 + smoothNoise(seed + 19, x * 2.13) * 0.35;

/**
 * The rig's pose at progress u (0..1): where the camera is, and what it aims at.
 * Pure — no three.js, no clock, no allocation the caller can't see.
 *
 * `ctx.center` is the world point the rig is built around — origin for every
 * classic type, the followed layer's CURRENT position for Follow Object. The rig
 * stays a leaf module exactly because the caller resolves that point: this file
 * never learns what a channel or an item is.
 */
export function evalCameraRig(rig, u, ctx = null) {
  const r = normalizeCameraRig(rig);
  const t = Math.max(0, Math.min(1, num(u, 0)));
  const c = ctx?.center
    ? { x: num(ctx.center.x, 0), y: num(ctx.center.y, 0), z: num(ctx.center.z, 0) }
    : { x: 0, y: 0, z: 0 };
  const pos = rigPosition(r, t, c);

  // Tilt raises/lowers the AIM POINT rather than rotating the camera in place, so
  // the subject stays framed instead of sliding out of shot as the rig travels.
  const lift = -r.height * (r.tilt / 45);
  if (r.aim === 'path') {
    // Path align: look one radius ahead along the direction of travel, with the
    // same tilt lift on top. A rig that isn't moving has no direction, so it keeps
    // facing its centre rather than snapping to an arbitrary heading.
    const dir = rigTravelDirection(r, t, c);
    if (dir) {
      const reach = r.radius;
      return {
        pos,
        aim: { x: pos.x + dir.x * reach, y: pos.y + dir.y * reach + lift, z: pos.z + dir.z * reach },
        roll: r.roll,
      };
    }
  }
  return { pos, aim: { x: c.x, y: c.y + lift, z: c.z }, roll: r.roll };
}

/**
 * Unit direction the camera travels at progress t, or null when the move is
 * standing still (Sweep 0, Travel 0, a handheld with no Amount).
 *
 * Measured in PROGRESS space, never time: an eased camPathT (Smooth, AE Smooth…) parks the camera
 * at both ends, but the move still points somewhere there. The difference stays
 * central even at 0 and 1 — the builders are closed-form, so a hair past either
 * end is just the move's own continuation, and clamping would give a chord that
 * turns the end frames off the true heading. The window widens when the local
 * step vanishes — Push In's ease-out has zero speed exactly at t = 1 and the
 * handheld noise flattens on every lattice point, yet both have a well-defined
 * heading a little further out.
 */
function rigTravelDirection(r, t, c) {
  for (const h of [1e-3, 1e-2, 5e-2]) {
    const a = rigPosition(r, t - h, c);
    const b = rigPosition(r, t + h, c);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dy, dz);
    if (len > 1e-3) return { x: dx / len, y: dy / len, z: dz / len };
  }
  return null;
}

// Where the camera stands at progress t — the per-type builders. `r` is already
// normalized and `c` resolved; evalCameraRig adds the aim.
function rigPosition(r, t, c) {
  const ang = (a) => a * D2R;
  let pos;

  switch (r.type) {
    case 'follow': {
      // Orbit maths re-based onto the followed object: the whole move rides the
      // target drone-style while the parameters keep their orbit meanings, and a
      // moving target drags the camera with it even at a fixed progress.
      const a = ang(r.startAngle + r.sweep * t);
      pos = { x: c.x + Math.sin(a) * r.radius, y: c.y - r.height, z: c.z + Math.cos(a) * r.radius };
      break;
    }
    case 'dolly': {
      const a = ang(r.startAngle);
      const d = r.radius + r.distance * (1 - t);
      pos = { x: Math.sin(a) * d, y: -r.height, z: Math.cos(a) * d };
      break;
    }
    case 'pushIn': {
      // Same travel as dolly, eased hard at the end — the shot lands rather than
      // arrives.
      const a = ang(r.startAngle);
      const e = 1 - (1 - t) ** 3;
      const d = r.radius + r.distance * (1 - e);
      pos = { x: Math.sin(a) * d, y: -r.height, z: Math.cos(a) * d };
      break;
    }
    case 'truck': {
      // Lateral slide at a fixed depth, perpendicular to the sightline.
      const a = ang(r.startAngle);
      const off = r.distance * (t - 0.5);
      pos = {
        x: Math.sin(a) * r.radius + Math.cos(a) * off,
        y: -r.height,
        z: Math.cos(a) * r.radius - Math.sin(a) * off,
      };
      break;
    }
    case 'crane': {
      const a = ang(r.startAngle + r.sweep * t);
      pos = { x: Math.sin(a) * r.radius, y: -(r.height + r.rise * t), z: Math.cos(a) * r.radius };
      break;
    }
    case 'spiral': {
      const a = ang(r.startAngle + r.sweep * r.turns * t);
      const rad = r.radius * (1 - 0.35 * t);
      pos = { x: Math.sin(a) * rad, y: -(r.height + r.rise * t), z: Math.cos(a) * rad };
      break;
    }
    case 'handheld': {
      const a = ang(r.startAngle);
      const p = t * Math.max(0, r.frequency);
      pos = {
        x: Math.sin(a) * r.radius + drift(r.seed, p) * r.amplitude,
        y: -r.height + drift(r.seed + 51, p) * r.amplitude * 0.7,
        z: Math.cos(a) * r.radius + drift(r.seed + 97, p) * r.amplitude * 0.5,
      };
      break;
    }
    case 'orbit':
    default: {
      const a = ang(r.startAngle + r.sweep * t);
      pos = { x: Math.sin(a) * r.radius, y: -r.height, z: Math.cos(a) * r.radius };
      break;
    }
  }

  return pos;
}

/** Sampled polyline of the whole move — the 3D view draws this, and the endpoint
 *  handles are its first and last entries. */
export function sampleCameraRig(rig, n = 96, ctx = null) {
  const out = [];
  const steps = Math.max(2, Math.round(n));
  for (let i = 0; i <= steps; i += 1) out.push(evalCameraRig(rig, i / steps, ctx).pos);
  return out;
}

/**
 * Solve `startAngle`/`radius`/`height` (and `sweep` for the far end) from a dragged
 * endpoint. The handle is never the source of truth: the drag is converted back to
 * parameters, written to the rig, and the next frame rebuilds the handle from those
 * — so a wrong solve is visible immediately instead of drifting.
 */
export function cameraRigFromEndpoint(rig, which, point, ctx = null) {
  const r = normalizeCameraRig(rig);
  let x = num(point?.x, 0);
  let y = num(point?.y, 0);
  let z = num(point?.z, 0);
  // A Follow rig lives in the followed object's frame, so the dragged world point
  // is re-based onto the same centre the evaluator adds — then the orbit solve
  // below applies unchanged.
  if (r.type === 'follow' && ctx?.center) {
    x -= num(ctx.center.x, 0);
    y -= num(ctx.center.y, 0);
    z -= num(ctx.center.z, 0);
  }
  const radius = Math.max(CAMERA_RIG_PARAM_META.radius.min, Math.hypot(x, z));
  const angle = Math.atan2(x, z) / D2R;

  const rounded = (key, value) => Math.round(num(
    value,
    r[key],
    CAMERA_RIG_PARAM_META[key]?.min,
    CAMERA_RIG_PARAM_META[key]?.max,
  ) * 10) / 10;
  const nearestAngle = (raw, expected) => raw + 360 * Math.round((expected - raw) / 360);

  if (r.type === 'dolly' || r.type === 'pushIn') {
    // The near endpoint is `radius`; the far endpoint is `radius + distance`.
    // Keep the opposite endpoint's distance while moving either handle.
    if (which === 'end') {
      const nextRadius = rounded('radius', radius);
      return {
        startAngle: rounded('startAngle', angle),
        radius: nextRadius,
        distance: rounded('distance', r.radius + r.distance - nextRadius),
        height: rounded('height', -y),
      };
    }
    return {
      startAngle: rounded('startAngle', angle),
      distance: rounded('distance', radius - r.radius),
      height: rounded('height', -y),
    };
  }

  if (r.type === 'truck') {
    // Decompose onto the current sightline and its perpendicular truck axis.
    const a = r.startAngle * D2R;
    const forwardRadius = x * Math.sin(a) + z * Math.cos(a);
    const lateralOffset = x * Math.cos(a) - z * Math.sin(a);
    return {
      radius: rounded('radius', forwardRadius),
      distance: rounded('distance', (which === 'end' ? 2 : -2) * lateralOffset),
      height: rounded('height', -y),
    };
  }

  if (r.type === 'handheld') {
    // Remove the deterministic shake at this endpoint, then solve the underlying
    // locked-off pose. Moving either handle therefore moves the rig instead of
    // pretending handheld has a sweep/distance parameter it never reads.
    const t = which === 'end' ? 1 : 0;
    const p = t * r.frequency;
    const bx = x - drift(r.seed, p) * r.amplitude;
    const by = y - drift(r.seed + 51, p) * r.amplitude * 0.7;
    const bz = z - drift(r.seed + 97, p) * r.amplitude * 0.5;
    return {
      startAngle: rounded('startAngle', Math.atan2(bx, bz) / D2R),
      radius: rounded('radius', Math.hypot(bx, bz)),
      height: rounded('height', -by),
    };
  }

  if (which === 'end') {
    const expectedEnd = r.startAngle + r.sweep * (r.type === 'spiral' ? r.turns : 1);
    const unwrappedEnd = nearestAngle(angle, expectedEnd);
    const patch = {
      radius: rounded('radius', r.type === 'spiral' ? radius / 0.65 : radius),
      height: rounded('height', r.type === 'crane' || r.type === 'spiral' ? r.height : -y),
      sweep: rounded('sweep', (unwrappedEnd - r.startAngle) / (r.type === 'spiral' ? r.turns : 1)),
    };
    if (r.type === 'crane' || r.type === 'spiral') patch.rise = rounded('rise', -y - r.height);
    return patch;
  }
  return {
    startAngle: rounded('startAngle', angle),
    radius: rounded('radius', radius),
    height: rounded('height', -y),
  };
}

// Presets are COMPLETE rigs, not fragments: one that sets only `type` leaves the
// previous shot's radius behind and reads as broken.
export const CAMERA_RIG_PRESETS = [
  { id: 'heroOrbit', name: 'Hero Orbit', rig: { type: 'orbit', radius: 1800, height: 400, startAngle: -40, sweep: 90, tilt: -8 } },
  { id: 'slowReveal', name: 'Slow Reveal', rig: { type: 'orbit', radius: 2400, height: 220, startAngle: -120, sweep: 150, tilt: -4 } },
  { id: 'turntable', name: 'Turntable', rig: { type: 'orbit', radius: 1500, height: 300, startAngle: 0, sweep: 360, tilt: -6 } },
  { id: 'craneDown', name: 'Crane Down', rig: { type: 'crane', radius: 1700, height: 1400, startAngle: -30, sweep: 55, rise: -1100, tilt: 14 } },
  { id: 'riseReveal', name: 'Rise & Reveal', rig: { type: 'crane', radius: 1900, height: 150, startAngle: -60, sweep: 80, rise: 1200, tilt: -16 } },
  { id: 'pushIn', name: 'Push In', rig: { type: 'pushIn', radius: 900, height: 260, startAngle: 0, distance: 1800, tilt: -3 } },
  { id: 'pullBack', name: 'Pull Back', rig: { type: 'dolly', radius: 2600, height: 380, startAngle: 12, distance: -1700, tilt: -6 } },
  { id: 'truckLeft', name: 'Truck Left', rig: { type: 'truck', radius: 1600, height: 300, startAngle: 0, distance: 2200, tilt: -4 } },
  // Retuned: the spiral pulls IN as it climbs (`radius * (1 - 0.35 * t)`), so the
  // start radius has to leave room for that. At 2200 the move ended 1430 out and
  // 1140 up and a normal product left the top of frame. 2800 lands the tightest
  // moment at ~0.79 of frame height with the climb intact. Framing is a joint
  // property of radius + rise + tilt here — retuning one alone just moves the clip.
  { id: 'productSpiral', name: 'Product Spiral', rig: { type: 'spiral', radius: 2800, height: 240, startAngle: -20, sweep: 300, turns: 1, rise: 800, tilt: -16 } },
  { id: 'handheldDrift', name: 'Handheld Drift', rig: { type: 'handheld', radius: 1500, height: 320, startAngle: -8, amplitude: 90, frequency: 1.5, tilt: -5 } },
  // Follow presets carry NO targets — which layer to ride is project wiring, not
  // part of a shot. The panel preserves the current list when a preset is applied.
  { id: 'droneFollow', name: 'Drone Follow', rig: { type: 'follow', radius: 1600, height: 420, startAngle: -35, sweep: 110, tilt: -7 } },
  // A rear three-quarter chase: low, tight, and barely swinging — reads as a
  // camera operator running behind the subject rather than a crane circling it.
  { id: 'chaseCam', name: 'Chase Cam', rig: { type: 'follow', radius: 950, height: 170, startAngle: 160, sweep: 35, tilt: -4 } },
];

export function cameraRigPreset(id) {
  const hit = CAMERA_RIG_PRESETS.find((p) => p.id === id);
  return hit ? normalizeCameraRig(hit.rig) : null;
}

/**
 * The `camPathT` track a rig needs to actually move: 0 % → 0, 100 % → 100.
 *
 * Without this a freshly applied rig sits frozen at its start pose and reads as
 * broken — the parameters are all there, nothing animates, and the fix (open the
 * keyframe builder and hand-author two keys) is invisible. Returns null when the
 * track already has keys, so re-picking a preset never destroys hand-tuned timing.
 */
export function seedCameraRigProgress(propertyKeyframes) {
  const existing = propertyKeyframes?.camPathT;
  if (Array.isArray(existing) && existing.length > 0) return null;
  return {
    ...(propertyKeyframes || {}),
    // `position`, NOT `time`, and `'Linear'`, NOT `'linear'`.
    //
    // A keyframe in this project is `{ position, value, easing }` with position in
    // 0-100 percent of the clip. Written as `time` both keys parsed to position 0,
    // the de-duplicator then collapsed them into one, and the result was a rig with
    // a single 0 % key — visibly "the rig only made one keyframe", and a camera that
    // never moved because progress never advanced. The easing string has to be a
    // TransitionEasing VALUE ('Linear'), not its key name, or the sanitizer silently
    // substitutes the default. Linear like every Path Progress track
    // (objectMotionPath.js PATH_PROGRESS_EASING — not imported, this is a leaf).
    camPathT: [
      { position: 0, value: 0, easing: 'Linear' },
      { position: 100, value: 100, easing: 'Linear' },
    ],
  };
}
