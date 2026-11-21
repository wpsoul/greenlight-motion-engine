/*
 * (lookfix) A Final Scene frame's shutter, as the world traces it in one pass (WorldRenderer.setMotionBlur): the times its poses are taken at,
 * the Scene layer and clock it keeps across a cut, its Rig's keyed lights, exposure and texture-graph numbers at each of those times. Pure
 * data over the timeline's Scene entries (engine/projectDerive.js deriveRigEntries): the app's render page (world3dLayer.js
 * worldMotionBlur), which a render farm's pod runs too (farmparity), poses the shutter from it.
 */
import { normalizeRig, resolveRigAt, rigUsesWorld, sceneTimeAt } from './rig3d.js';
import { worldLiveValues, worldSceneFromRig } from './world3dScene.js';

/** The `count` times of the shutter's poses: `window` seconds centred on `time`, evenly from its opening to its close, clamped to 0 .. `maxTime`. */
export function shutterTimes(time, window, count, maxTime = Infinity) {
  return Array.from({ length: count }, (_, k) => Math.max(0, Math.min(maxTime, time - window / 2 + (window * k) / (count - 1))));
}

/** (mblur5) The Rig of the Scene layer showing at `time`, at any time `t` of that frame's shutter (`rigAt(t)`: the timeline's Rig at t, its keys
 *  applied): its keys at `t`, and past the layer's ends the Rig as its nearer end has it. A shutter that crosses a cut into another Scene layer
 *  keeps the frame's own Scene for its whole length, as each frame of an edit shows its own shot. */
export function shutterRigIn(entries, time, rigAt) {
  const own = resolveRigAt(entries, time);
  return (t) => {
    if (!own || resolveRigAt(entries, t)?.itemId === own.itemId) return rigAt(t);
    const inside = Math.min(own.endTime - 1e-6, Math.max(own.startTime + 1e-6, t));
    return resolveRigAt(entries, inside)?.itemId === own.itemId ? rigAt(inside) : own.rig;
  };
}

/** (mblur5) The Scene's own clock (rig3d.js sceneTimeAt) of the Scene layer showing at `time`, at any time `t` of that frame's shutter: past a
 *  cut it keeps counting on the frame's own Scene's clock (held at its end), not the next layer's. `t` itself with no Scene layer. */
export function shutterClockIn(entries, time) {
  const own = resolveRigAt(entries, time);
  if (!own) return (t) => sceneTimeAt(entries, t);
  return (t) => sceneTimeAt([own], t);
}

/** (engine100b) The exposure the Rig's keys give a world Scene's film at time `t` (its environment's; 1 for anything else). */
export function shutterExposureAt(rigAt, t) {
  const rig = rigAt(t);
  const e = rigUsesWorld(rig) ? normalizeRig(rig).env.exposure : 1;
  return e > 0 ? e : 1;
}

/** (mblur3) What the world takes in place from a keyed Rig at time `t` (worldLiveValues: its lights, environment, backdrop paint, catchers,
 *  texture-graph numbers), from the Scene as it rests (`resting`) and the frame's world options (`options`: size, models, materials,
 *  backdrop); null where the Rig is not keyed or not a world. */
export function shutterLiveValues(rigAt, resting, options) {
  return (t) => {
    const rig = rigAt(t);
    if (!rigUsesWorld(rig) || !resting || resting === rig || !options) return null;
    const { look: _look, exposure: _exposure, ...structure } = worldSceneFromRig(rig, { ...options, resting });
    return worldLiveValues(structure);
  };
}

/** (mblur6) The Rig's keys on its texture graphs' numbers across the shutter of the frame at `time` (`window` seconds centred on it): (u) =>
 *  the graphs' numbers at a share u (0..1) of the shutter, or null when they hold still across it (its opening, middle and close). */
export function shutterGraphsIn(rigAt, resting, options, time, window) {
  if (!(window > 0) || !resting || !options) return null;
  const graphsAt = (t) => {
    const rig = rigAt(t);
    if (!rigUsesWorld(rig)) return null;
    const { look: _look, exposure: _exposure, ...structure } = worldSceneFromRig(rig, { ...options, resting });
    return worldLiveValues(structure).graphs;
  };
  const t0 = time - window / 2;
  const own = JSON.stringify(graphsAt(time) || {});
  if ([t0, t0 + window].every((t) => JSON.stringify(graphsAt(t) || {}) === own)) return null;
  return (u) => graphsAt(t0 + window * Math.min(1, Math.max(0, u))) || {};
}
