// Particle bake, off the main thread.
//
// The solver is a pure function of its config (no DOM, no three.js), which is what
// makes this file three lines of protocol rather than a port of anything: the same
// bakeParticles the main thread calls, addressed by message.
//
// The result's two big typed arrays are TRANSFERRED, not copied — a 6 s / 2000
// particle cache is ~10 MB, and structured-cloning that on every solver edit would
// hand back the hitch this worker exists to remove.
//
// Cancellation is by generation number, and it lives on the CLIENT: a worker that
// is already mid-bake cannot be interrupted usefully (the bake is a tight loop of a
// few tens of ms), so the client simply ignores results whose generation is stale.

import { bakeParticles } from './solver.js';

self.onmessage = (event) => {
  const { id, key, system, duration, spawn, collider, colliderTrack, colliderTables, colliderTracks, emitterGate, layerDrive, proximity, objectShapes } = event.data || {};
  try {
    // Progressive: every chunk of finished snapshots is COPIED out (the bake
    // keeps writing into its own arrays) and transferred, so the editor can draw
    // the clip filling in. The final message carries the complete cache.
    const onChunk = (c) => {
      const data = new Float32Array(c.data), uids = new Int32Array(c.uids);
      const lifeOf = new Float32Array(c.lifeOf), releaseOf = new Float32Array(c.releaseOf);
      const rot = c.rot ? new Float32Array(c.rot) : null;
      const transfer = [data.buffer, uids.buffer, lifeOf.buffer, releaseOf.buffer];
      if (rot) transfer.push(rot.buffer);
      self.postMessage({ id, key, chunk: { ...c, data, uids, lifeOf, releaseOf, rot } }, transfer);
    };
    const cache = bakeParticles(system, duration, spawn || null, collider || null, { onChunk, layerDrive: layerDrive || null, proximity: proximity || null, colliderTrack: colliderTrack || null, colliderTables: colliderTables || null, colliderTracks: colliderTracks || null, emitterGate: emitterGate || null, objectShapes: objectShapes || null });
    const transfer = [cache.data.buffer, cache.uids.buffer];
    if (cache.rot) transfer.push(cache.rot.buffer);
    self.postMessage({ id, key, cache }, transfer);
  } catch (error) {
    // A bake that throws must not take the editor's particles with it: the client
    // keeps showing the last good cache and reports the failure once.
    self.postMessage({ id, key, error: String(error?.message || error) });
  }
};
