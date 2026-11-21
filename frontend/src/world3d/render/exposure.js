// (octane2) The camera's own exposure from its ISO, shutter and aperture, as a photographer sets it. Plain JS (tested in lut.test.mjs).

/** A shutter as written: seconds (0.02) or a fraction ("1/50"). */
export function shutterSeconds(v) {
  if (typeof v === 'number') return v > 0 ? v : null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*s?\s*$/.exec(String(v ?? ''));
  if (m) return +m[1] / +m[2];
  const x = parseFloat(v);
  return x > 0 ? x : null;
}

/** The camera's exposure as a multiplier of the picture's light: 1 at ISO 100, 1/50 s, f/4, and one stop (×2) more for each doubling
 *  of ISO or of the shutter time, or each f-stop wider (fStop / √2). Null unless the camera sets `iso` or `shutter`: a camera that only
 *  sets `fStop` (depth of field) keeps its exposure. */
export function physicalExposure(cam) {
  if (!cam || (cam.iso == null && cam.shutter == null)) return null;
  const iso = Number(cam.iso) > 0 ? Number(cam.iso) : 100;
  const t = shutterSeconds(cam.shutter) ?? 1 / 50;
  const n = Number(cam.fStop) > 0 ? Number(cam.fStop) : 4;
  return (iso / 100) * (t * 50) * ((4 * 4) / (n * n));
}
