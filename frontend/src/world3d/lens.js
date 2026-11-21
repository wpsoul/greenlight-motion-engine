// The scene camera's lens as plain numbers (item 11 "cameras"): orthographic, shifted, focused on a tilted plane. No three here, so the
// renderer (render/cameraLens.js), the critique's frame tests (inspect.js inFrame, cameraPath.js) and the tests read one definition.

const DEG = Math.PI / 180;
// the plane of focus may lean this far off the film, degrees: at 90 it would hold the view's own axis
const TILT_MAX = 89.5;

/** The lens a scene's camera asks for at one time, from its fields already sampled: `projection`, `orthoHeight`, `shift`, `tilt`,
 *  `tiltRotation`. `distance` is the camera's to its target (an orthographic frame left without a height frames the target as the
 *  perspective one would), `fov` the vertical field of view in degrees. Plain numbers, so the tests and the critique read it too. */
export function lensOf({ projection, orthoHeight, shift, tilt, tiltRotation }, { distance = 3, fov = 28 } = {}) {
  const ortho = typeof projection === 'string' && /^ortho/i.test(projection);
  const fallback = 2 * Math.max(1e-3, distance) * Math.tan((Math.min(170, Math.max(1, fov)) * DEG) / 2);
  const height = ortho ? (Number.isFinite(orthoHeight) && orthoHeight > 0 ? orthoHeight : fallback) : 0;
  const s = Array.isArray(shift) ? shift : [0, 0];
  const sx = Number.isFinite(s[0]) ? Math.min(2, Math.max(-2, s[0])) : 0, sy = Number.isFinite(s[1]) ? Math.min(2, Math.max(-2, s[1])) : 0;
  const t = Number.isFinite(tilt) ? Math.min(TILT_MAX, Math.max(-TILT_MAX, tilt)) : 0;
  return { ortho, height, shift: [sx, sy], tilt: ortho ? 0 : t, tiltRotation: Number.isFinite(tiltRotation) ? tiltRotation : 0 };
}

/** The tilted plane's normal in the camera's own space (x right, y up, looking down -z), toward the camera: a tilt leans the plane's top
 *  away from the camera (the ground a camera looks down on, all of it sharp); `rotation` turns the hinge about the view. */
export function tiltNormal(tilt, rotation = 0) {
  const a = tilt * DEG, r = rotation * DEG;
  return [-Math.sin(a) * Math.sin(r), Math.sin(a) * Math.cos(r), Math.cos(a)];
}

/** One over the depth (along the view, 1/metres) at which the plane of focus crosses the view ray through camera-space direction [x, y, -1]:
 *  the plane holds the focus point (`planeDot` is that point's dot with `n`, both in camera space) and leans as `n` says. 0 is a ray that runs
 *  along the plane (sharp at infinity); below 0, a ray whose line meets the plane behind the camera (a focus "past infinity": everything
 *  along it is nearer than its focus). Linear across the frame, which is what keeps the sharp band's edges straight and its blur smooth. */
export function focusInverseAt(rx, ry, planeDot, n) {
  return Math.abs(planeDot) > 1e-9 ? (rx * n[0] + ry * n[1] - n[2]) / planeDot : 0;
}

/** (enginefix4) Which side of the frame a scene camera's `sensor` millimetres span, as Blender's sensor fit: `"HORIZONTAL"` the width,
 *  `"VERTICAL"` the height, `"AUTO"` (the default) the longer side. `aspect` is the frame's width over its height. */
const sensorAcross = (fit, aspect) => {
  const f = typeof fit === 'string' ? fit.toUpperCase() : 'AUTO';
  return f === 'HORIZONTAL' || (f !== 'VERTICAL' && aspect >= 1);
};

/** (enginefix4) The film a scene camera exposes on a frame of `aspect`: its width and height in mm, from `sensor` [36] on the side its
 *  `sensorFit` names. The focal length that gives a field of view, and so the lens's blur, is measured on this film: a portrait frame
 *  with a HORIZONTAL fit (Blender's own for a vertical film) has 36 mm across its width and 64 mm up its height at 9:16, and its 85 mm
 *  lens is 85 mm, not the 48 mm the same view gives on 36 mm up the height (half the blur). */
export function filmOf(cam, aspect) {
  const sensor = Number(cam?.sensor) > 0 ? Number(cam.sensor) : 36;
  const a = aspect > 0 ? aspect : 16 / 9;
  return sensorAcross(cam?.sensorFit, a) ? { width: sensor, height: sensor / a } : { width: sensor * a, height: sensor };
}

/** three's film gauge for that film: three lays `filmGauge` along the frame's longer side (its getFilmHeight / getFocalLength), so the
 *  film's height times the larger of the aspect and 1. */
export function filmGaugeOf(cam, aspect) {
  const a = aspect > 0 ? aspect : 16 / 9;
  return filmOf(cam, a).height * Math.max(a, 1);
}

/** (enginefix4) The vertical field of view (degrees) a scene camera films at on a frame of `aspect`. `lens` (mm) wins: on its film
 *  (filmOf). Otherwise `fov`, the vertical view on the frame it was taken for: `frame` [width, height] when the camera names one (a .blend
 *  import does), else this one. On a frame of another shape the sensor keeps its side, as Blender frames it: the tangent of half the view
 *  along that side stays and the other side follows the frame. */
export function sceneFov(cam, fov, aspect) {
  const a = aspect > 0 ? aspect : 16 / 9;
  const lens = Number(cam?.lens);
  if (lens > 0) return (2 * Math.atan(filmOf(cam, a).height / 2 / lens)) / DEG;
  const frame = cam?.frame;
  if (!Array.isArray(frame) || !(frame[0] > 0) || !(frame[1] > 0)) return fov;
  const src = frame[0] / frame[1];
  if (Math.abs(src - a) < 1e-6) return fov;
  const held = Math.tan((fov * DEG) / 2) * (sensorAcross(cam.sensorFit, src) ? src : 1);
  return (2 * Math.atan(sensorAcross(cam.sensorFit, a) ? held / a : held)) / DEG;
}

/** A thin lens's circle of confusion across, in pixels, for a point at view depth `z` on a ray focused at inverse depth `inverse`
 *  (focusInverseAt; 1 / the focus distance for an untilted lens): the aperture `aperture` metres across, `pxPerTan` pixels per unit of
 *  tangent (the frame's height over twice the tangent of half its view). */
export function cocPixels(z, inverse, aperture, pxPerTan) {
  if (!(z > 0)) return 0;
  return aperture * Math.abs(1 / z - inverse) * pxPerTan;
}

/** Whether a point at view depth `depth`, `x` right and `y` up of the view's axis (metres), is inside the frame of `lens` (lensOf's): a
 *  perspective one `tan` (the tangent of half its vertical view) and `aspect` wide, an orthographic one `lens.height` tall; a shift moves
 *  the frame by its own width and height. With neither, the test the critique always made. */
export function inLensFrame(depth, x, y, lens, tan, aspect) {
  const [sx, sy] = lens.shift;
  const hh = lens.ortho ? lens.height / 2 : depth * tan, hw = hh * aspect;
  if (!sx && !sy) return Math.abs(y) <= hh && Math.abs(x) <= hw;
  return Math.abs(y - 2 * sy * hh) <= hh && Math.abs(x - 2 * sx * hw) <= hw;
}

// (physcam) A wide-angle lens as a lens model: a fisheye projection of the scene camera (`projection`: "stereographic", "equidistant",
// "equisolid"). The image-plane radius r (half the frame's height = 1) of a direction θ off the axis is 2f·tan(θ/2), f·θ or 2f·sin(θ/2), f set
// so the frame's top middle is at half the camera's vertical `fov`. Final traces each pixel's ray through it (the tracer's "Fisheye"); Draft
// draws a straight lens wide enough to hold the frame's corners (`rectTan`, the tangent of its half vertical view) and bends its picture, its
// depth and its masks into the fisheye's (WorldRenderer #lensWarp).
export const FISHEYE_MODES = Object.freeze({ stereographic: 1, equidistant: 2, equisolid: 3 });
/** The widest angle off the axis Draft's straight lens can hold (its corners further out are the edge's pixels stretched): 80°. */
export const FISHEYE_RECT_MAX = 80;

/** θ (radians) of image-plane radius `r` for lens model `mode` and scale `f`. */
export function fisheyeTheta(mode, r, f) {
  const x = r / f;
  if (mode === 2) return x;
  if (mode === 3) return 2 * Math.asin(Math.min(1, x / 2));
  return 2 * Math.atan(x / 2);
}

/** The image-plane radius of θ (radians). */
export function fisheyeRadius(mode, theta, f) {
  if (mode === 2) return f * theta;
  if (mode === 3) return 2 * f * Math.sin(theta / 2);
  return 2 * f * Math.tan(theta / 2);
}

/** The vertical view (degrees) a fisheye of focal length `lensMm` gives on film `filmHeight` mm tall. */
export function fisheyeLensFov(mode, lensMm, filmHeight) {
  return (2 * fisheyeTheta(mode, filmHeight / 2, lensMm)) / DEG;
}

/** The fisheye a scene camera asks for at vertical view `fov` (degrees) on a frame `aspect` wide, or null for a straight lens:
 *  { mode, f, rectTan, cornerDeg, rectFov }. `rectFov` is the vertical view of the straight lens Draft draws (it holds the frame's corners, up
 *  to FISHEYE_RECT_MAX off the axis). */
export function fisheyeOf(projection, fov, aspect) {
  const mode = FISHEYE_MODES[projection];
  if (!mode) return null;
  const a = aspect > 0 ? aspect : 16 / 9;
  const half = (Math.min(300, Math.max(1, Number(fov) || 28)) * DEG) / 2;
  const f = mode === 2 ? 1 / half : mode === 3 ? 1 / (2 * Math.sin(Math.min(Math.PI / 2, half) / 2)) : 1 / (2 * Math.tan(Math.min(Math.PI * 0.99, half) / 2));
  const rc = Math.hypot(a, 1);
  const corner = fisheyeTheta(mode, rc, f);
  const held = Math.min(corner, FISHEYE_RECT_MAX * DEG);
  const rectTan = Math.tan(held) / rc;
  return { mode, f, rectTan, cornerDeg: corner / DEG, rectFov: (2 * Math.atan(rectTan)) / DEG };
}

/** Where in the straight lens's frame (uv, 0..1) the fisheye frame's pixel at `uv` comes from: Draft's bend, as #lensWarp draws it. */
export function fisheyeSource(fish, u, v, aspect) {
  const a = aspect > 0 ? aspect : 16 / 9;
  const cx = (u - 0.5) * 2 * a, cy = (v - 0.5) * 2;
  const r = Math.hypot(cx, cy);
  if (r < 1e-9) return [0.5, 0.5];
  const t = Math.tan(Math.min(fisheyeTheta(fish.mode, r, fish.f), Math.PI / 2 - 1e-4)) / fish.rectTan;
  return [0.5 + (cx / r) * t / (2 * a), 0.5 + (cy / r) * t / 2];
}
