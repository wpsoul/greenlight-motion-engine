/*
 * What the Scene layer means to the world renderer: the Rig's backdrop, lights and environment, and the 3D layers on the
 * timeline, as one world3d scene (frontend/src/world3d/README.md). Pure data, so the node tests can load it.
 *
 * Units. The editor's 3D space is one unit per composition pixel, Y up. The world works in metres-like units, because
 * shadow biases, the tracer's ray offsets and every Blender scene assume them, so everything crossing over is scaled by
 * WORLD_UNITS. Radiance has no length in it; only point and spot candela scale, with the square.
 */
import { normalizeRig, resolveEnvUrl, vectorFromSpherical, lightTarget, areaLuminance, candelaIntensity } from './rig3d.js';

export const WORLD_UNITS = 0.001;

const scaled = (p) => [p.x * WORLD_UNITS, p.y * WORLD_UNITS, p.z * WORLD_UNITS];

// How much of the distance to the subject a lamp's radius is at softness 1: what the Rig's soft shadow filter opens by (rigSoftShadows.lightSpread).
const LAMP_RADIUS = 0.11;

/** How much of a panel's width lights what stands straight in front of it, through a cone that reaches `reach` there and fades to nothing at that edge. */
const spreadShare = (half, reach) => {
  const t = Math.min(1, half / reach);
  return ((t - (t * t) / 2) * reach) / half;
};

/** A spot projects its picture, an area light wears an image on its panel. Everything else casts it, from something out of frame:
 *  a panel's light is too wide to carry a pattern across the set, and a sun has no cone to project through. */
function lightPicture(light) {
  const t = light.texture;
  if (!t?.url && !t?.pattern) return null;
  const picture = t.url ? { image: t.url } : { pattern: t.pattern };
  return light.type === 'spot' || (light.type === 'area' && t.url) ? { texture: picture } : { gobo: picture };
}

/** One Rig light as a world light, or null for the kinds a path tracer has no use for (they become environment). */
export function worldLight(light) {
  const level = light.on === false ? 0 : light.intensity;
  const base = { id: light.lid, color: light.color };
  if (light.type === 'ambient' || light.type === 'hemisphere') return null;
  const p = vectorFromSpherical(light.az, light.elev, light.dist);
  const softness = light.shadowSoftness ?? 1;
  const picture = lightPicture(light);
  // The Rig's switch, in Final as in Draft. What a light shines through can only show as a shadow, so that keeps it on.
  const shadow = light.castShadow === false && !picture?.gobo ? { castShadow: false } : null;
  if (light.type === 'directional') {
    return { ...base, type: 'sun', dir: scaled(p), intensity: level, size: 1 + softness * 2, ...picture, ...shadow };
  }
  const t = lightTarget(light);
  const d = Math.max(1, Math.hypot(p.x - t.x, p.y - t.y, p.z - t.z));
  if (light.type === 'area') {
    // Softness is the panel's size: a bigger box lights the subject the same, only softer. 0 would be a panel of no size at all.
    const k = Math.max(0.05, softness), width = light.width * k, height = light.height * k;
    const focused = light.spread != null && light.spread < 180;
    // A Rig's intensity is what the subject receives, and a narrow cone shows it only part of the panel: the rest comes back here.
    const reach = focused ? d * Math.tan((light.spread * Math.PI) / 360) : 0;
    const seen = focused ? spreadShare(width / 2, reach) * spreadShare(height / 2, reach) : 1;
    return {
      ...base, type: 'area', at: scaled(p), target: scaled(t),
      width: width * WORLD_UNITS, height: height * WORLD_UNITS,
      intensity: areaLuminance(level, d, width, height) / seen,
      ...(focused ? { spread: light.spread } : null), ...picture, ...shadow,
    };
  }
  const decay = light.type === 'point' ? light.decay : 2;
  const intensity = candelaIntensity(level, light.dist, decay) * WORLD_UNITS ** decay;
  const radius = softness * LAMP_RADIUS * d * WORLD_UNITS;
  if (light.type === 'point') return { ...base, type: 'point', at: scaled(p), intensity, radius, ...shadow };
  return { ...base, type: 'spot', at: scaled(p), target: scaled(t), angle: light.angle, penumbra: light.penumbra, intensity, radius, ...picture, ...shadow };
}

/** How far the Camera layer has come from rest, for a scene that has its own shot. Movement is a share of the way to what it looks at, so
 *  the same drag orbits any scene's subject, and turning stays as it is. `rest` is the proxy's distance before it moves. */
export function worldSteer(proxy, rest) {
  const half = (fov) => Math.tan((fov * Math.PI) / 360);
  return {
    position: [proxy.position.x / rest, proxy.position.y / rest, (proxy.position.z - rest) / rest],
    quaternion: proxy.quaternion.toArray(),
    zoom: half(28) / half(proxy.fov),
  };
}

/** `models`: [{ id, name, url } | { id, name, splat } | { id, name, baked, material }]. `backdrop`: true when the Rig's set has a mesh. */
export function worldSceneFromRig(rawRig, { W, H, models = [], materials = {}, particles = [], backdrop = false, duration = 10, fps = 30 }) {
  const rig = normalizeRig(rawRig);
  const lights = rig.lights.map(worldLight).filter(Boolean);
  // A flat Ambient has no direction to trace, so it joins the environment it is closest to in the render.
  const ambient = rig.lights.filter((l) => l.type === 'ambient' || l.type === 'hemisphere')
    .reduce((sum, l) => sum + (l.on === false ? 0 : l.intensity), 0);
  const env = { intensity: rig.env.intensity + ambient, rotation: rig.env.rotY, background: rig.cyclorama?.shape === 'none' && rawRig?.scene ? 'env' : 'none' };
  const hdri = resolveEnvUrl(rig.env);
  if (hdri) env.hdri = hdri;
  if (rig.env.tint) env.tint = rig.env.tint;
  Object.assign(env, rawRig?.scene?.env);
  // What an agent built: world3d objects, materials and particles, in world units, living on the Scene.
  const built = rawRig?.scene && typeof rawRig.scene === 'object' ? rawRig.scene : {};
  const objects = [], mats = { ...(built.materials || {}), ...materials };
  if (backdrop) {
    const m = rig.cyclorama.material || {};
    // One-sided, and casting nothing unless asked. Back-face culling is what lets the camera stand outside a room, and a set
    // shadowing itself is acne with no upside (model3dLayer.js, syncCyclorama).
    mats.backdrop = { base: m.color || '#d8d8d8', roughness: m.roughness ?? 0.8, metalness: m.metalness ?? 0 };
    if (m.mode === 'image' && m.imageUrl) mats.backdrop.maps = { base: m.imageUrl };
    const c = rig.cyclorama;
    objects.push({ id: 'backdrop', name: 'Backdrop', baked: 'backdrop', material: 'backdrop', rev: [c.shape, c.width, c.height, c.depth, c.curve, c.scale, H].join(), ...(m.mode === 'shadowCatcher' ? { catcher: { tint: m.shadowColor || '#000000', strength: m.opacity ?? 1 } } : {}), castShadow: m.castShadow === true, receiveShadow: m.receiveShadow !== false });
  }
  for (const m of models) {
    const rigid = m.rigid ? { rigid: m.rigid } : {};
    if (m.splat) objects.push({ id: m.id, name: m.name, splat: m.splat, ...rigid });
    else objects.push(m.url ? { id: m.id, name: m.name, model: m.url, ...rigid } : { id: m.id, name: m.name, baked: m.baked, material: m.material, rev: m.rev, ...rigid });
  }
  if (Array.isArray(built.objects)) objects.push(...built.objects);
  return {
    version: 1, name: 'Scene', duration, fps, size: [W, H],
    camera: built.camera || { at: [0, 0, 2], target: [0, 0, 0], fov: 28 },
    env, lights: [...lights, ...(Array.isArray(built.lights) ? built.lights : [])], materials: mats, objects,
    particles: [...particles, ...(Array.isArray(built.particles) ? built.particles : [])],
    volumes: Array.isArray(built.volumes) ? built.volumes : [],
    matter: Array.isArray(built.matter) ? built.matter : [],
    ...(built.anim ? { anim: built.anim } : {}),
    // The set's floor stands 0.42 of a composition below the middle (model3dLayer.js). Gravity is under Earth's: a composition is about
    // a metre tall, and a drop at full strength is over before the eye finds it.
    ...(built.physics || objects.some((o) => o.rigid) ? { physics: built.physics || { floor: (-H * 0.42 + (rig.cyclorama?.y || 0)) * WORLD_UNITS, gravity: [0, -5, 0] } } : {}),
    look: rawRig?.look || {}, exposure: (Number.isFinite(rawRig?.exposure) ? rawRig.exposure : 1) * rig.env.exposure,
  };
}

/** What a Rig's keys change in a built scene, and the world takes in place on every frame (WorldRenderer.relight): the lights, the
 *  environment's strength and turn, and the backdrop's paint. Its place is a pose like any object's, and everything else is what a
 *  rebuild is for. */
export function worldLiveValues(scene) {
  const backdrop = scene.objects.find((o) => o.id === 'backdrop');
  const paint = backdrop && scene.materials[backdrop.material];
  return {
    lights: scene.lights,
    env: { intensity: scene.env.intensity, rotation: scene.env.rotation },
    materials: paint ? { [backdrop.material]: { base: paint.base } } : {},
    catchers: backdrop?.catcher ? { [backdrop.id]: backdrop.catcher } : {},
  };
}

/** A pixel-space matrix in world units: rows scale, so a child's own scale stays what it was. */
export function worldMatrix(m) {
  const out = Array.from(m);
  for (let i = 0; i < 15; i++) if ((i + 1) % 4) out[i] *= WORLD_UNITS;
  return out;
}

/**
 * The editor's lens as a thin lens. Its blur is a circle of RADIUS cocScale × |focus − d| / d pixels (the compositor gathers that
 * far); a thin lens's circle has a DIAMETER of A·f/(F − f) × W/film for the same expression, so the two agree when
 * A = 2 × cocScale × (F − f) / f × film / W. Taking the radius for the diameter made Final half as blurred as Draft.
 * One pixel is one millimetre here.
 */
export function worldLens(dof, W, fov, aspect, film = 36) {
  if (!dof?.enabled || !(dof.aperture > 0) || !(dof.blurLevel > 0)) return { fStop: 0, focus: dof?.focusDistance ? dof.focusDistance * WORLD_UNITS : undefined };
  const filmHeight = film / Math.max(aspect, 1);
  const f = filmHeight / (2 * Math.tan((fov * Math.PI) / 360));
  const cocScale = dof.aperture * (dof.blurLevel / 100);
  const A = ((2 * cocScale * Math.max(1, dof.focusDistance - f)) / f) * (film / W);
  return { fStop: f / A, focus: dof.focusDistance * WORLD_UNITS };
}

/** The editor's camera pose for the world: same view, in world units. */
export function worldCamera(proxy, fallbackDistance) {
  if (!proxy) return { position: [0, 0, fallbackDistance * WORLD_UNITS], quaternion: [0, 0, 0, 1], fov: 28 };
  return {
    position: proxy.position.toArray().map((v) => v * WORLD_UNITS),
    quaternion: proxy.quaternion.toArray(),
    fov: proxy.fov,
  };
}
