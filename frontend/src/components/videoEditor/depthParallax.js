// 3D Depth (2.5D parallax) for image and video layers.
//
// A monocular depth model (Depth Anything V2 small, run in a worker — see
// depthWorker.js) turns a photo into a depth map once; the map is stored on the
// item as a small base64 PNG, exactly like the adjustment-layer .cube LUT, so it
// travels with the project and re-renders identically in exports with no media
// sidecar and no server round-trip.
//
// A VIDEO layer gets the same single map, frozen from one chosen frame and held
// for the whole clip — the map is the same object, measured once, and nothing in
// this file knows or cares which kind of plate it came from. canUseDepthEffects
// in depthMapEffect.js carries why it is one frame and not each of them.
//
// At render time the clip shader shifts each pixel's sampling UV by its depth.
// The driver is the PROJECT CAMERA, not the mouse: a camera pan/dolly/tilt moves
// near pixels further than far ones, which is what makes a flat photo read as a
// dimensional scene. The camera rig already translates the whole layer uniformly
// (Player.applyCameraRig); this adds only the depth-dependent RESIDUAL on top, so
// with depth off the frame is byte-identical to before.
//
// Note camZoom deliberately produces NO parallax — it is a lens zoom (rig x/y
// scale), and a real zoom flattens rather than reveals. camDolly is the move that
// pushes the camera through the scene, so that one does.

import {
  DEPTH_MAX_EDGE,
  canUseDepthEffects,
  generateDepthMap,
  getDepthTexture,
  getItemDepthMap,
  hasDepthMap,
  onDepthTextureLoaded,
  releaseDepthWorker,
} from './depthMapEffect.js';

/*
 * The depth MAP, its texture cache and the model run all moved to
 * depthMapEffect.js in 10.4.89 — several effects sample the same map now, so it
 * is owned by its own 'Build Depth Map' entry rather than by this one. These
 * re-exports keep every existing `from './depthParallax'` import resolving.
 */
export {
  DEPTH_MAX_EDGE,
  generateDepthMap,
  getDepthTexture,
  getItemDepthMap,
  hasDepthMap,
  onDepthTextureLoaded,
  releaseDepthWorker,
};

// Gains convert camera units into UV shift at depthStrength = 100 %.
//
// Calibrated against what the camera PRESETS actually do, not against round
// numbers: the pan-style presets move camX by about ±7, the handheld ones by well
// under ±1, and only a whip pan reaches ±45. The camera rig already slides the
// whole layer by (camX/100) × frame width — 134px at camX 7 on a 1920 frame — so
// what has to be visible is the near-vs-far DIFFERENCE within that slide. A gain
// of 1.0 makes the near plane travel roughly 40 % further than the far one on a
// typical preset, which is what reads as depth; the earlier 0.15 produced ~6 %,
// i.e. nothing.
const LATERAL_GAIN = 1.0;    // per 1.0 of (camX|camY / 100)
const TILT_GAIN = 0.008;     // per degree — presets tilt ~±4.5° against a ±7 pan
const DOLLY_GAIN = 0.0003;   // radial, per px — presets dolly ~±80–170

// Ceiling on the displacement coefficient, so a whip pan (camX 45+) can't ask for
// a warp so large the plate visibly tears. Past this the parallax stops growing
// but keeps its direction, which degrades gracefully instead of falling apart.
const MAX_COEFF = 0.09;

export const DEPTH_PARALLAX_LAYER_EFFECT_ID = 'depth3d';

export const DEPTH_DEFAULTS = {
  depthStrength: 100,  // %
  depthFocus: 45,      // % of the depth range that stays pinned
};

export const DEPTH_NUMBER_FIELDS = [
  { key: 'depthStrength', label: 'Strength', min: 0, max: 300, step: 5, suffix: '%', kf: true },
  { key: 'depthFocus', label: 'Focus Plane', min: 0, max: 100, step: 1, suffix: '%', kf: true },
];

export const DEPTH_KF_KEYS = DEPTH_NUMBER_FIELDS.filter((f) => f.kf).map((f) => f.key);

export function getDepthParallaxEffect(item) {
  const list = item?.layerEffects;
  if (!Array.isArray(list)) return null;
  return list.find((effect) => effect?.id === DEPTH_PARALLAX_LAYER_EFFECT_ID) || null;
}

// Kept as a named gate because the panel and the registry both read it; the rule
// itself is shared by every Depth Effect now.
export const canUseDepthParallax = canUseDepthEffects;

export function isDepthParallaxEnabled(item) {
  const effect = getDepthParallaxEffect(item);
  if (!effect || effect.enabled === false || !hasDepthMap(item)) return false;
  const strength = Number.isFinite(effect.params?.depthStrength)
    ? effect.params.depthStrength
    : DEPTH_DEFAULTS.depthStrength;
  return strength > 0.01;
}

export function resolveDepthParams(item, keyframeProps) {
  const params = getDepthParallaxEffect(item)?.params || {};
  const pick = (key) => {
    const kf = keyframeProps?.[key];
    if (Number.isFinite(kf)) return kf;
    return Number.isFinite(params[key]) ? params[key] : DEPTH_DEFAULTS[key];
  };
  return { depthStrength: pick('depthStrength'), depthFocus: pick('depthFocus') };
}

// ── Camera pose → parallax ──────────────────────────────────────────────────

// Resolve the depth-dependent residual for a camera pose. Returns null when the
// pose is neutral/absent so the caller can take the exact-bypass path.
// `shiftX/shiftY` are UV offsets at (depth - focus) = 1; `dolly` is a radial
// scale term applied the same way.
export function getDepthCameraShift(pose, strengthPct) {
  if (!pose) return null;
  const s = Math.max(0, strengthPct) / 100;
  if (s <= 0) return null;
  const n = (v) => (Number.isFinite(v) ? v : 0);
  const cap = (v) => Math.max(-MAX_COEFF, Math.min(MAX_COEFF, v));
  // Camera moving right (camX+) must push near pixels further left than far ones.
  // Sampling further right on the plate is what makes content appear to move left.
  const shiftX = cap((n(pose.camX) / 100) * LATERAL_GAIN * s + n(pose.camTiltY) * TILT_GAIN * s);
  // camY+ is the camera moving down. The rig raises the content (+y in three), and
  // the plate's V axis runs up with it, so the near plane needs the same sign here.
  const shiftY = cap((n(pose.camY) / 100) * LATERAL_GAIN * s + n(pose.camTiltX) * TILT_GAIN * s);
  // Positive camDolly pushes the camera in; the shader magnifies the near plane
  // more than the far one.
  const dolly = cap(n(pose.camDolly) * DOLLY_GAIN * s);
  if (Math.abs(shiftX) < 1e-5 && Math.abs(shiftY) < 1e-5 && Math.abs(dolly) < 1e-6) return null;
  return { shiftX, shiftY, dolly };
}
