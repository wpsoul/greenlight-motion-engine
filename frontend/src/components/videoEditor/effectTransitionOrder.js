export const EFFECT_TRANSITION_ORDER = Object.freeze([
  'source',
  'overlay-effects',
  'transition',
  'composite',
]);

function hasTransition(type) {
  return typeof type === 'string' && type.length > 0 && type !== 'None';
}

// Returns the transition stage that is active for one timeline item. Player uses
// this as the gate for baking Overlay Effects into an isolated layer plate before
// any transition mutates that plate's transform, opacity, wipe, or package input.
export function activeEffectPrecomposeStage({
  activeIndex = 0,
  overlapIn = 0,
  timeInClip = 0,
  duration = 0,
  transitionInType = 'None',
  transitionInDuration = 1,
  transitionOutType = 'None',
  transitionOutDuration = 1,
} = {}) {
  if (activeIndex > 0 && overlapIn > 0 && timeInClip <= overlapIn) return 'cross';

  const inDuration = Number.isFinite(transitionInDuration) && transitionInDuration > 0
    ? transitionInDuration
    : 1;
  if (hasTransition(transitionInType) && timeInClip < inDuration) return 'in';

  const outDuration = Number.isFinite(transitionOutDuration) && transitionOutDuration > 0
    ? transitionOutDuration
    : 1;
  if (hasTransition(transitionOutType) && timeInClip > duration - outDuration) return 'out';

  return null;
}
