// The 3D layers' prime before a still or a render (renderWarmup.waitForMediaReady), as its own function so its rounds can be
// unit-tested (renderPrime.test.mjs): no imports.
//
// Model layers load a second wave of resources LAZILY on their first real render (the Player's own model module import, per-entry
// environment PMREM, screen artwork, first-use GPU texture uploads) — and each of those only STARTS once the previous one landed. A
// single prime+settle pass therefore "settles" before anything is pending (the first prime merely kicks the module import), which
// is why range renders still opened on empty frames. So the prime captures and settles ITERATIVELY until a whole round finds nothing
// pending, at least two rounds, then draws the first time once more with everything that landed.
//
// A WARM page (backend/render_warm.py keeps a project's render page for its next still) has done that before. When the first round
// started no load and no world build since this page's last prime ended (`primed`, the `stamp` it ended on), nothing is pending and
// the world is not building, everything the frame draws is loaded and was drawn by that round: the second round, its 150 ms beats and
// the closing capture only proved it again (~1 s of every warm 3D still). Anything new — an edit that adds a model, an environment, a
// texture, a rebuild of the world — moves the stamp and the rounds run as on a cold page.
//
//   capture(t)     one prime capture at t (loads and draws, no trace). Its readback stays: without it the night desk's first Draft
//                  still came back with the sky through its walls and took 13.4 s instead of 8.8 s (the readback is what lets the
//                  world's own GPU reads, e.g. its sky-behind-walls measure, finish in time on a page that presents nothing)
//   times          the times to prime at (renderWarmup.model3dPrimeTimes)
//   pending()      model resources still loading (model3dLayer.modelResourcesPending)
//   settled()      waits for them (modelResourcesSettled)
//   worldSettled() waits for the world's load and build (world3dLayer.worldSettled)
//   worldBusy()    the world is loading or building now (world3dLayer.worldBusy)
//   stamp()        the loads and builds started so far (model3dLayer.modelResourceStarts / world3dLayer.worldBuildsStarted)
//   primed         the stamp this page's last prime ended on; null on a page that has not primed
// Returns { stamp, captures, quick }: the stamp to keep for the next prime, how many captures ran, whether the warm path was taken.
export async function primeRounds({ capture, times, pending, settled, worldSettled, worldBusy, stamp, primed = null,
  beat = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  let captures = 0;
  let quick = false;
  for (let round = 0; round < 6; round += 1) {
    for (const t of times) {
      await capture(t);
      captures += 1;
    }
    if (round === 0 && primed !== null && primed === stamp() && !pending() && !worldBusy()) {
      quick = true;
      break;
    }
    // Give freshly-kicked dynamic imports / loaders a beat to register.
    await beat(150);
    const hadPending = pending();
    await settled();
    await worldSettled();
    if (!hadPending && round > 0) break;
  }
  if (!quick) {
    await capture(times[0]);
    captures += 1;
  }
  return { stamp: stamp(), captures, quick };
}
