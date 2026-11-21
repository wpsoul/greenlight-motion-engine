// (leftovers-rig) A rig's solve (core.js computeRig: joints, heat weights, fixes, four influences a vertex) off the page's thread. The same
// code on the same numbers as the page would run, so the weights are the same to the bit; only the result comes back (the dense weights
// and the surface stay here). The world carries this file as text (html/world3d-lab/build.mjs, __WORLD3D_RIG_SRC__), the editor as Vite's
// worker (components/videoEditor/rigSolveEditor.js). Plain JS: no three, no DOM, no dynamic import.
import { computeRig } from './core.js';

self.onmessage = ({ data }) => {
  const { id, spec, meshes } = data || {};
  try {
    const { W, S, ...kept } = computeRig(spec, meshes);
    const transfer = [];
    for (const inf of kept.influences || []) transfer.push(inf.skinIndex.buffer, inf.skinWeight.buffer);
    self.postMessage({ id, result: kept }, transfer);
  } catch (error) {
    self.postMessage({ id, error: String(error?.message || error) });
  }
};
