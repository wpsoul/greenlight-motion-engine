// (leftovers-rig) The editor's rig worker: a model layer's skeleton (model3dConfig.skeleton) has its weights solved here, off the page's
// thread (world3d/rig/rigWorker.js through Vite's worker bundling: the `new Worker(new URL(...))` must stay literal for Vite to see it).
// One worker for the page, made on the first skeleton; none without one.
import { makeRigSolver } from '../../world3d/rig/rigSolver.js';

let solver;
export function editorRigSolver() {
  if (solver !== undefined) return solver;
  solver = typeof Worker !== 'undefined'
    ? makeRigSolver(() => new Worker(new URL('../../world3d/rig/rigWorker.js', import.meta.url), { type: 'module' }))
    : null;
  return solver;
}
