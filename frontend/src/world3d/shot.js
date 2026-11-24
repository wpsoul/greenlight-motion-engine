// (enginefix4) A Scene camera's shot as the world films it: its fields at given times through the world's own evaluator (keys.js
// sampleField: keys and their ƒx, drives on the scene's clocks, expressions), and the view it films at (lens.js sceneFov), exactly
// what WorldRenderer.applyTime reads. The Camera layer's converter (backend/camera_layer.py) reads a driven camera through this
// (shotCli.mjs, run by node), so a converted shot is the world's own and there is no second evaluator to drift from it.
import { sampleField } from './keys.js';
import { sceneFov } from './lens.js';

/** The camera fields a shot carries, as applyTime samples them (`up` does not animate: it is the camera's own). */
export const SHOT_FIELDS = ['at', 'target', 'up', 'fov', 'lens', 'focus', 'fStop'];

/** Whether a camera is read through this evaluator by the converter: it moves by more than its keys (a drive, an ƒx over its keys), or
 *  its view comes from a `lens` on its film. backend/camera_layer.py is_driven. */
export const isDriven = (camera) => !!camera && (Object.keys(camera.drive || {}).length > 0 || Object.keys(camera.fx || {}).length > 0
  || !!camera.lens || !!camera.keys?.lens);

/** The camera's fields at each of `times` (seconds on the Scene's clock): [{ t, at, target, up, fov, lens?, focus?, fStop?, view? }], a
 *  field left out where the camera has none. `scene` gives the clocks and fps its drives read ({ clocks, fps }); with `aspect` (the
 *  frame's width / height) each time also has `view`, the vertical fov the world films at on that frame (its sensor fit's). */
export function cameraShot(camera, scene, times, aspect = null) {
  const sc = scene && typeof scene === 'object' ? scene : {};
  return (times || []).map((t) => {
    const out = { t };
    for (const f of SHOT_FIELDS) {
      const v = f === 'up' ? camera?.up : sampleField(camera, f, t, sc);
      if (v !== undefined && v !== null) out[f] = v;
    }
    if (aspect > 0) out.view = sceneFov({ ...camera, lens: out.lens }, out.fov ?? 28, aspect);
    return out;
  });
}
