// (leftovers-rig) Rigs solved in a worker (rigWorker.js), so a big mesh's weights (0.5 s for 18k vertices, 2 s for 73k) never hold the page.
// `makeRigSolver(makeWorker)` returns solve(spec, meshes) -> Promise of computeRig's result without its dense weights, or null at once when
// there is no worker to be had (then the caller solves on its own thread as before). One worker, made on the first solve, kept for the
// page; a worker that fails answers null to every call it held and is not used again.

export function makeRigSolver(makeWorker) {
  let worker = null, broken = false, ids = 0;
  const calls = new Map();
  const fail = () => {
    broken = true;
    for (const done of calls.values()) done(null);
    calls.clear();
    try { worker?.terminate(); } catch { /* gone already */ }
    worker = null;
  };
  const solve = (spec, meshes) => {
    if (broken) return null;
    if (!worker) {
      try {
        worker = makeWorker();
        if (!worker) { broken = true; return null; }
      } catch { broken = true; return null; }
      worker.onmessage = ({ data }) => {
        const done = calls.get(data?.id);
        if (!done) return;
        calls.delete(data.id);
        done(data.error ? null : data.result);
      };
      worker.onerror = (e) => { e?.preventDefault?.(); fail(); };
    }
    const id = (ids += 1);
    return new Promise((resolve) => {
      calls.set(id, resolve);
      // the points are the caller's own copies (bind.js rigMeshes): handed over, not copied again
      const transfer = [];
      for (const m of meshes) { if (m.position?.buffer) transfer.push(m.position.buffer); if (m.index?.buffer) transfer.push(m.index.buffer); }
      try { worker.postMessage({ id, spec, meshes }, [...new Set(transfer)]); } catch { calls.delete(id); resolve(null); }
    });
  };
  /** Lets the worker go (a call still out answers null). */
  solve.dispose = () => { const was = broken; fail(); broken = was; };
  return solve;
}
