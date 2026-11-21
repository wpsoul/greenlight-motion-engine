// (enginebugs) The Scene's own `env.intensity` is the environment's strength; the Rig's (`rig.env.intensity`, the Rig panel's Environment
// Intensity) is then not used. One written beside the other with another value is a number that does nothing: the validator (validate.js,
// and backend/world3d_schema.py word for word) and a still's scene warnings (world3dLayer.js) say so. Plain, so the editor's chunk can
// take it without the schema.

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

export function envStrengthMessage(rigValue, sceneValue) {
  return `rig.env.intensity ${rigValue} is not used: the Scene's own scene.env.intensity ${sceneValue} is the environment's strength (the Rig's environment keys still scale it in proportion). Keep one: delete scene.env.intensity to let rig.env.intensity (the Rig panel's Environment Intensity) set it, or set the strength you want in scene.env.intensity`;
}

/** The Rig's environment strength as it rests untouched (rig3d.js ENV_DEFAULTS.intensity; the editor writes it into every Rig it saves). */
export const RIG_ENV_INTENSITY_DEFAULT = 1;

/** The message for a Rig whose environment strength was moved off its default while the Scene's own replaces it with another value; null
 *  otherwise (an untouched Rig says nothing: the editor stores its default 1 in every Rig, under every agent's scene). */
export function envStrengthShadowed(rig) {
  const own = rig?.scene?.env?.intensity, mine = rig?.env?.intensity;
  if (!finite(own) || !finite(mine) || Math.abs(own - mine) < 1e-6 || Math.abs(mine - RIG_ENV_INTENSITY_DEFAULT) < 1e-6) return null;
  return envStrengthMessage(mine, own);
}
