/*
 * What the Scene layer means to the world renderer: the Rig's backdrop, lights and environment, and the 3D layers on the
 * timeline, as one world3d scene (frontend/src/world3d/README.md). Pure data, so the node tests can load it.
 *
 * Units. The editor's 3D space is one unit per composition pixel, Y up. The world works in metres-like units, because
 * shadow biases, the tracer's ray offsets and every Blender scene assume them, so everything crossing over is scaled by
 * WORLD_UNITS. Radiance has no length in it; only point and spot candela scale, with the square.
 */
import { normalizeRig, resolveEnvUrl, vectorFromSpherical, lightTarget, areaLuminance, candelaIntensity, animatedGraphOf } from './rig3d.js';

export const WORLD_UNITS = 0.001;

// The neutral grid tile laid on floors and the backdrop in a Blocking prerender: 256 px, #c9ced6 with #b3bac4 lines every 64 px and a
// 2 px #8c96a4 edge. A PNG, never an SVG: the world decodes maps with createImageBitmap (world3d/host.js), which refuses an SVG, and
// the whole Scene then failed to build, so every Blocking @video1 came out as the empty background (16.6.35).
export const BLOCKING_GRID_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAIAAADTED8xAAAD90lEQVR42u3VsQ3EIBBFQfoXMRXQAZljEicOXY+3C4vdkShg7v4+ufUxPa/sa/4CTwDzft5D37r2uXj+358A+AUgAH4BGIBfAAbgF4AB+AVgAH4BGIBfAAbgF4AB+AVgAH4BGIBfAAbgF4AB+AVgAH4BGIBfAAbgF4AB+AVgAH4BGIBfAAbgF4AB+AVgAH4BGIBfAAbgF4AB+AVgAH4BOCB+ATggfgE4IH4BOCB+ATggfgE4IH4BOCB+ATggfgE4IH4BOCB+ATggfgE4IH4BOCB+ATggfgHw8wuAn18A/PwC4OcXAD+/APj5BcDPLwB+fgHw8wuAn18A/PwC4BeAAPgFYAB+ARiAXwAG4BeAAfgFYAB+ARiAXwAG4BeAAfjzBhA/w/MKPl8Afl8AAfALwAD8AjAAvwAMwC8AA/ALwAD8AjAAvwAMwC8AA/ALwAD8AjAAvwAMwC8AA/ALwAD8AjAAvwAMwC8AA/ALwAD8AjAAvwAMwC8AA/ALwAD8AjAAvwAMwC8AA/ALwAHxC8AB8QvAAfELwAHxC8AB8QvAAfELwAHxC8AB8QvAAfELwAHxC8AB8QvAAfELwAHxC8AB8QuAn18A/PwC4OcXAD+/APj5BcDPLwB+fgHw8wuAn18A/PwC4OcXAL8ABMAvAAPwC8AA/AIwAL8ADMAvAAPwC8AA/AIwAL8ADMAvAAPwC8AA/NkCiJ/heQWfLwC/L4AA+AVgAH4BGIBfAAbgF4AB+AVgAH4BGIBfAAbgF4AB+AVgAH4BGIBfAAbgF4AB+AVgAH4BGIBfAAbgF4AB+AVgAH4BGIBfAAbgF4AB+AVgAH4BGIBfAAbgF4AB+AXggPgF4ID4BeCA+AXggPgF4ID4BeCA+AXggPgF4ID4BeCA+AXggPgF4ID4BeCA+AXggPgF4ID4BcDPLwB+fgHw8wuAn18A/PwC4OcXAD+/APj5BcDPLwB+fgHw8wuAXwAC4BeAAfgFYAB+ARiAXwAG4BeAAfgFYAB+ARiAXwAG4BeAAfgFYAD+bAHEz/C8gs8XgN8XQAD8AjAAvwAMwC8AA/ALwAD8AjAAvwAMwC8AA/ALwAD8AjAAvwAMwC8AA/ALwAD8AjAAvwAMwC8AA/ALwAD8AjAAvwAMwC8AA/ALwAD8AjAAvwAMwC8AA/ALwAD8AnBA/AJwQPwCcED8AnBA/AJwQPwCcED8AnBA/AJwQPwCcED8AnBA/AJwQPwCcED8AnBA/AJwQPwC4OcXAD+/APj5BcDPLwB+fgHw8wuAn18A/PwC4OcXAD+/APj5BcAvAAHwC8AA/AIwAL8ADMAvAAPwC8AA/AIwAL8ADMAvAAPwC8AA/AIwAH8a/wfyYyewQHcNAwAAAABJRU5ErkJggg==';

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

// A flat Ambient has no direction to trace, so it joins the environment it is closest to in the render.
const isAmbient = (l) => l.type === 'ambient' || l.type === 'hemisphere';
const ambientOf = (rig) => rig.lights.filter(isAmbient).reduce((sum, l) => sum + (l.on === false ? 0 : l.intensity), 0);

/** A light's colour as linear light, three channels 0..1 (what three makes of an sRGB colour): '#rgb', '#rrggbb', '#rrggbbaa', or the
 *  'rgba(r, g, b, a)' a colour key evaluates to between two keys (gsapTransitions.js toRgbaString). Anything else is white. */
const linearOf = (value) => {
  const s = String(value || '').trim();
  let rgb = null;
  const hex = /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s);
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].replace(/./g, (c) => c + c) : hex[1].slice(0, 6);
    rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  } else {
    const fn = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(s);
    if (fn) rgb = [fn[1], fn[2], fn[3]].map(Number);
  }
  return (rgb || [255, 255, 255]).map((v) => { const c = Math.min(Math.max(v / 255, 0), 1); return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
};

/** (ownercalls) The light the Ambients and Hemispheres add to a world's environment, as they rest and as keys move them. Their strength joins
 *  the environment's (ambientOf); their colour tints it by its share of that light, channel by channel in linear light, as three draws the
 *  same lights on a classic Rig: the sky half of the map by (env + Σ a·colour) / (env + Σ a), the ground half the same with each
 *  Hemisphere's ground colour (an Ambient lights both halves alike). [r, g, b], or [sky r, g, b, ground r, g, b] when the halves differ.
 *  `envStrength`: the map's own strength (0 for the flat world an Ambient makes where there is no map).
 *  Null when every colour is white (the map as it is: the environment and a white Ambient draw exactly as before). */
function ambientTint(rig, envStrength = rig.env.intensity) {
  const sky = [0, 0, 0], ground = [0, 0, 0];
  let total = 0;
  for (const l of rig.lights) {
    if (!isAmbient(l)) continue;
    const a = l.on === false ? 0 : l.intensity;
    if (!(a > 0)) continue;
    const up = linearOf(l.color), down = l.type === 'hemisphere' ? linearOf(l.groundColor) : up;
    total += a;
    for (let i = 0; i < 3; i++) { sky[i] += a * up[i]; ground[i] += a * down[i]; }
  }
  const env = Math.max(0, envStrength || 0), whole = env + total;
  if (!(total > 0) || !(whole > 0)) return null;
  const share = (v) => Math.round(((env + v) / whole) * 1e5) / 1e5;
  const s = sky.map(share), g = ground.map(share);
  const split = g.some((v, i) => Math.abs(v - s[i]) > 1e-5);
  if (!split && s.every((v) => Math.abs(v - 1) < 1e-5)) return null;
  return split ? [...s, ...g] : s;
}

/** A tint as [sky r, g, b, ground r, g, b]. */
const tintHalves = (t) => (t ? (t.length === 6 ? t : [...t, ...t]) : [1, 1, 1, 1, 1, 1]);

/** (ownercalls) A scene with its own environment strength takes the Rig's ambient light only as keys move it (the scene's strength takes
 *  the Rig's environment and Ambients' place at rest, worldSceneFromRig): the tint now over the tint at rest, half by half. */
function keyedTint(rig, rest) {
  const now = tintHalves(ambientTint(rig)), was = tintHalves(ambientTint(rest));
  const t = now.map((v, i) => Math.round((v / Math.max(was[i], 1e-5)) * 1e5) / 1e5);
  if (t.every((v) => Math.abs(v - 1) < 1e-5)) return null;
  return t.slice(0, 3).every((v, i) => Math.abs(v - t[i + 3]) < 1e-5) ? t.slice(0, 3) : t;
}

/** `models`: [{ id, name, url, skeleton? } | { id, name, splat } | { id, name, baked, material }]. `backdrop`: true when the Rig's set has a mesh.
 *  `resting`: the Rig without its keys, when `rawRig` is the Rig at a keyed moment (world3dLayer). */
export function worldSceneFromRig(rawRig, { W, H, models = [], materials = {}, backdrop = false, duration = 10, fps = 30, resting = null }) {
  const rig = normalizeRig(rawRig);
  const lights = rig.lights.map(worldLight).filter(Boolean);
  const ambient = ambientOf(rig);
  const env = { intensity: rig.env.intensity + ambient, rotation: rig.env.rotY, background: rig.cyclorama?.shape === 'none' && rawRig?.scene ? 'env' : 'none' };
  const hdri = resolveEnvUrl(rig.env);
  if (hdri) env.hdri = hdri;
  if (rig.env.tint) env.tint = rig.env.tint;
  // (vfx34) a map made of a shot's frames names its key light's direction (vfxScene environment keyDir)
  if (Array.isArray(rawRig?.env?.keyDir) && rawRig.env.keyDir.length === 3) env.keyDir = rawRig.env.keyDir;
  Object.assign(env, rawRig?.scene?.env);
  // (Stage 0) A scene's own environment strength or turn took the Rig's place, its keys with it: a keyed Rig environment did nothing to a
  // scene that set its own. The Rig's keys now move the scene's values by as much as they move the Rig's own (its strength in proportion,
  // its turn by the same degrees); at rest, and with no keys, the scene's values are exactly what they were.
  const own = rawRig?.scene?.env;
  if (own && resting && resting !== rawRig) {
    const rest = normalizeRig(resting);
    if (Number.isFinite(own.intensity)) {
      const was = rest.env.intensity + ambientOf(rest), now = rig.env.intensity + ambient;
      env.intensity = was > 0 ? own.intensity * (now / was) : Math.max(0, own.intensity + now - was);
    }
    if (Number.isFinite(own.rotation)) env.rotation = own.rotation + (rig.env.rotY - rest.env.rotY);
  }
  // (ownercalls) With no map at all, an Ambient's or a Hemisphere's light was dropped in a world (it joins a map that is not there): it is
  // a flat world of its own light now (env.flat, its colour by the tint below), as bright as three lights a classic Rig with it: three
  // adds an Ambient's intensity × colour as irradiance (a diffuse surface returns albedo × intensity / π), and a flat world of radiance L
  // gives albedo × L, so L = intensity / π. Every such light counts, on, off or at 0, so a key on one never makes the world build again.
  const ownStrength = Number.isFinite(own?.intensity);
  const flat = !env.hdri && !env.sky && !env.flat && !ownStrength && rig.lights.some(isAmbient);
  if (flat) { env.flat = [1, 1, 1]; env.intensity = Math.round((ambient / Math.PI) * 1e6) / 1e6; }
  // (ownercalls) the Ambients' and Hemispheres' colours, as they rest and as keys move them; a scene with its own environment strength only
  // from where the Rig rests (that strength takes their place at rest)
  const tint = ownStrength ? (resting && resting !== rawRig ? keyedTint(rig, normalizeRig(resting)) : null) : ambientTint(rig, flat ? 0 : rig.env.intensity);
  if (tint) env.ambientTint = tint;
  // What an agent built: world3d objects, materials and sims, in world units, living on the Scene.
  const built = rawRig?.scene && typeof rawRig.scene === 'object' ? rawRig.scene : {};
  const prerenderLook = rawRig?.prerenderLook;
  const isClayOrBlocking = prerenderLook === 'clay' || prerenderLook === 'blocking';
  const muteBlocking = rawRig?.muteBlocking === true && !prerenderLook;
  const objects = [], mats = { ...(built.materials || {}), ...materials };
  if (isClayOrBlocking) {
    for (const key of Object.keys(mats)) {
      if (key === 'backdrop') continue;
      const orig = mats[key];
      if (orig?.pane === true) {
        mats[key] = { pane: true };
      } else if (Number(orig?.transmission) > 0.2 || (Number.isFinite(orig?.alpha) && orig.alpha < 0.85)) {
        mats[key] = { base: '#d5dbe3', roughness: 0.2, metalness: 0, alpha: 0.22 };
      } else if (prerenderLook === 'blocking' && /floor|ground|terrain|plane|stage|surface/i.test(key)) {
        mats[key] = { base: '#cfd4dc', roughness: 0.92, metalness: 0, uvScale: [8, 8], maps: { base: BLOCKING_GRID_DATA_URL } };
      } else {
        mats[key] = { base: '#c4c8cf', roughness: 0.86, metalness: 0 };
      }
    }
    if (typeof env.background === 'string' && env.background.startsWith('#')) {
      env.background = '#9aa3b0';
    }
  }
  if (muteBlocking) {
    // Keep world background transparent when blocking 3D geometry is muted so the placed
    // AI video plate underneath shows through cleanly while 3D Text & composites render on top.
    env.background = 'none';
    delete env.opaque;
    delete env.sky;
    delete env.view;
  }
  const backdropAllowed = backdrop && (!muteBlocking || rig.cyclorama?.material?.mode === 'shadowCatcher');
  if (backdropAllowed) {
    const m = rig.cyclorama.material || {};
    // One-sided, and casting nothing unless asked. Back-face culling is what lets the camera stand outside a room, and a set
    // shadowing itself is acne with no upside (model3dLayer.js, syncCyclorama).
    mats.backdrop = { base: m.color || '#d8d8d8', roughness: m.roughness ?? 0.8, metalness: m.metalness ?? 0 };
    if (m.mode === 'image' && m.imageUrl) mats.backdrop.maps = { base: m.imageUrl };
    // (ownercalls) A Solid or picture backdrop is as opaque as its opacity, at rest and as a key moves it (it was drawn opaque at rest
    // whatever its opacity), as on a classic Rig. "Shadows only" reads it as its shadow's strength (the catcher).
    if (m.mode !== 'shadowCatcher') {
      const alpha = Math.min(1, Math.max(0, Number.isFinite(m.opacity) ? m.opacity : 1));
      if (alpha < 1) mats.backdrop.alpha = Math.round(alpha * 1e4) / 1e4;
    }
    // (vfx) A floor that shows only shadows and also takes the objects' light (`light`, vfxScene.js): Final traces it in its own
    // colour, or in the footage's floor laid on it (`imageUrl`, uvs from cycloramaArrays), so their bounce takes the real floor's colour.
    const lit = m.mode === 'shadowCatcher' && m.light > 0;
    if (lit && m.imageUrl) mats.backdrop.maps = { base: m.imageUrl };
    if (prerenderLook === 'blocking') {
      mats.backdrop = { base: '#cfd4dc', roughness: 0.92, metalness: 0, uvScale: [12, 12], maps: { base: BLOCKING_GRID_DATA_URL } };
    } else if (prerenderLook === 'clay') {
      mats.backdrop = { base: '#bcc0c7', roughness: 0.9, metalness: 0 };
    }
    const c = rig.cyclorama;
    const needsUv = lit || prerenderLook === 'blocking';
    const isCatcher = m.mode === 'shadowCatcher' && prerenderLook !== 'blocking';
    // `rev` is what the backdrop's mesh is made of. Its scale is not: the mesh is built at scale 1 and scaled by its pose (cycloramaArrays'
    // matrix, posed every frame), so a new scale moves it in place, as a key on it does, and does not rebuild the world.
    objects.push({ id: 'backdrop', name: 'Backdrop', baked: 'backdrop', material: 'backdrop', rev: [c.shape, c.width, c.height, c.depth, c.curve, H, ...(needsUv ? ['uv'] : [])].join(), ...(isCatcher ? { catcher: { tint: m.shadowColor || '#000000', strength: m.opacity ?? 1, ...(lit ? { light: m.light } : {}) } } : {}), castShadow: m.castShadow === true, receiveShadow: m.receiveShadow !== false });
  }
  for (const m of models) {
    const rigid = m.rigid ? { rigid: m.rigid } : {};
    if (m.splat) objects.push({ id: m.id, name: m.name, splat: m.splat, ...rigid });
    else objects.push(m.url ? { id: m.id, name: m.name, model: m.url, ...rigid, ...(m.skeleton ? { skeleton: m.skeleton } : {}), ...(m.skinning ? { skinning: m.skinning } : {}) } : { id: m.id, name: m.name, baked: m.baked, material: m.material, rev: m.rev, ...rigid });
  }
  if (Array.isArray(built.objects)) {
    const builtObjs = muteBlocking ? built.objects.filter((o) => o?.aiRole === 'composite') : built.objects;
    objects.push(...builtObjs);
  }
  return {
    version: 1, name: 'Scene', duration, fps, size: [W, H],
    camera: built.camera || { at: [0, 0, 2], target: [0, 0, 0], fov: 28 },
    env, lights: [...lights, ...(Array.isArray(built.lights) ? built.lights : [])], materials: mats, objects,
    // simulations (sim/1 graphs or recipes, frontend/src/sim): only a scene that has them loads the sim bundle
    ...(Array.isArray(built.sims) && built.sims.length ? { sims: built.sims } : {}),
    volumes: Array.isArray(built.volumes) ? built.volumes : [],
    // flat pictures and words standing in the world (WorldRenderer #buildLayers2d); before the Scene schema they were dropped here unseen
    ...(Array.isArray(built.layers2d) && built.layers2d.length ? { layers2d: built.layers2d } : {}),
    // (animtools) the clocks the objects', the camera's and the cards' `drive` read (world3d/keys.js clockAt)
    ...(built.clocks && typeof built.clocks === 'object' && !Array.isArray(built.clocks) ? { clocks: built.clocks } : {}),
    ...(built.anim ? { anim: built.anim } : {}),
    // light-traced caustics in Final: on by itself under smooth glass and a light; an agent's true or false decides it
    ...(typeof built.caustics === 'boolean' ? { caustics: built.caustics } : {}),
    // the memory the texture graphs' automatic bake sizes may take, MB (WorldRenderer #graphSizes; 256 when not set)
    ...(Number.isFinite(built.textureBudget) ? { textureBudget: built.textureBudget } : {}),
    // (fogtrace) fog in the air of the set (WorldRenderer #buildFog): traced in Final, marched in Draft; none unless the scene has one
    ...(built.fog && typeof built.fog === 'object' ? { fog: built.fog } : {}),
    // The set's floor stands 0.42 of a composition below the middle (model3dLayer.js). Gravity is under Earth's: a composition is about
    // a metre tall, and a drop at full strength is over before the eye finds it.
    ...(built.physics || objects.some((o) => o.rigid) ? { physics: built.physics || { floor: (-H * 0.42 + (rig.cyclorama?.y || 0)) * WORLD_UNITS, gravity: [0, -5, 0] } } : {}),
    look: rawRig?.look || {}, exposure: (Number.isFinite(rawRig?.exposure) ? rawRig.exposure : 1) * rig.env.exposure,
  };
}

/** What a Rig's keys change in a built scene, and the world takes in place on every frame (WorldRenderer.relight): the lights, the
 *  environment's strength and turn, the backdrop's paint and (matpack) the numbers of a material's animated graph. Its place is a pose
 *  like any object's, and everything else is what a rebuild is for. */
export function worldLiveValues(scene) {
  const backdrop = scene.objects.find((o) => o.id === 'backdrop');
  const paint = backdrop && scene.materials[backdrop.material];
  const graphs = {};
  for (const id of Object.keys(scene.materials)) {
    const found = animatedGraphOf({ scene }, id);
    if (found) graphs[id] = found.graph;
  }
  return {
    lights: scene.lights,
    // (ownercalls) the Ambients' and Hemispheres' colours: the environment's tint (world3dScene ambientTint), none when every one is white
    env: { intensity: scene.env.intensity, rotation: scene.env.rotation, ...(scene.env.ambientTint ? { ambientTint: scene.env.ambientTint } : {}), ...(scene.env.sky ? { sky: scene.env.sky } : {}) },
    // (ownercalls) and the backdrop's opacity: its alpha, at rest and keyed
    materials: paint ? { [backdrop.material]: { base: paint.base, ...(paint.alpha < 1 ? { alpha: paint.alpha } : {}) } } : {},
    catchers: backdrop?.catcher ? { [backdrop.id]: backdrop.catcher } : {},
    graphs,
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
 * (enginefix4) `film` is the world's film gauge, laid along the frame's LONGER side: across the width that is film × min(aspect, 1).
 * Read as across the width on a portrait frame, Final's circle came out height / width larger than Draft's (1.78x at 9:16).
 */
export function worldLens(dof, W, fov, aspect, film = 36) {
  if (!dof?.enabled || !(dof.aperture > 0) || !(dof.blurLevel > 0)) return { fStop: 0, focus: dof?.focusDistance ? dof.focusDistance * WORLD_UNITS : undefined };
  const filmHeight = film / Math.max(aspect, 1), filmWidth = film * Math.min(aspect, 1);
  const f = filmHeight / (2 * Math.tan((fov * Math.PI) / 360));
  const cocScale = dof.aperture * (dof.blurLevel / 100);
  const A = ((2 * cocScale * Math.max(1, dof.focusDistance - f)) / f) * (filmWidth / W);
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
