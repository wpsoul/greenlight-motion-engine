// (camlayer) The Camera layer's shot in the world's terms, with no render: where the camera stands at a timeline time (metres, Y up, as
// a Scene's objects), where it looks, its up, its vertical field of view and lens, and the thin lens its depth of field hands Final, in
// every move mode (free keys, a Motion Path, a Camera Rig, Zoom). The same functions film the world (projectCamera.js resolveCameraPose →
// cameraProxyFromPose → world3dScene.js worldCamera / worldLens), so what this says is what Draft and Final show.
// backend/main.py's /api/world3d/camera-shot runs it through world3d/shotCli.mjs (node) for agents; the render page's critique reads it
// for the Camera layer's move over a Scene (critique.path).
import * as THREE from 'three';
import { cameraProxyFromPose, findCameraChannel, getCameraDofSettings, isCameraClip, perspectiveDistance, resolveCameraPose, sanitizeCameraPath } from './projectCamera';
import { cornersInFrame } from '../../world3d/cameraPath.js';
import { getTimelineLayout } from './speedUtils';
import { WORLD_UNITS, worldLens, worldSteer } from './world3dScene.js';
// (screensharp2) a Scene that films from its own camera: that camera at its clip's time, as the world reads it, steered by the Camera layer
import { cameraShot } from '../../world3d/shot.js';

const r4 = (v) => Math.round(v * 1e4) / 1e4;
const r6 = (v) => Math.round(v * 1e6) / 1e6;
const v3 = (v) => [r4(v.x), r4(v.y), r4(v.z)];

/** The world's film when the Camera layer films (36 mm along the frame's longer side: WorldRenderer #applyLens, worldLens): the focal
 *  length, mm, of a vertical field of view on a frame of this aspect. */
export function lensMmOf(fovDeg, aspect, film = 36) {
  return (film / Math.max(aspect, 1)) / (2 * Math.tan((fovDeg * Math.PI) / 360));
}

/** The Camera layer zoom that films a vertical field of view `fovDeg` (or a lens of `mm` on the world's 36 mm film): its fov at zoom 1 is
 *  28 degrees, and a zoom narrows it as a lens does, tan(fov / 2) = tan(14°) / zoom. */
export function zoomForFov(fovDeg) {
  return Math.tan((14 * Math.PI) / 180) / Math.tan((fovDeg * Math.PI) / 360);
}
export function zoomForLens(mm, aspect, film = 36) {
  return zoomForFov((2 * Math.atan((film / Math.max(aspect, 1)) / (2 * mm)) * 180) / Math.PI);
}

/** Project data as the editor holds it after a load, for the camera's own fields: a path's numbers, keys with a numeric position. */
function cleanChannels(channels) {
  return (channels || []).map((ch) => (ch?.kind !== 'camera' ? ch : {
    ...ch,
    items: (ch.items || []).map((it) => ({
      ...it,
      ...(it.cameraPath ? { cameraPath: sanitizeCameraPath(it.cameraPath) } : {}),
      propertyKeyframes: Object.fromEntries(Object.entries(it.propertyKeyframes || {}).map(([k, keys]) => [k,
        Array.isArray(keys) ? keys.filter((key) => key && Number.isFinite(Number.parseFloat(key.position))) : keys])),
    })),
  }));
}

/** The timeline's frame for the camera: { channels, clipsMap, layoutFor, width, height }. */
export function cameraTimeline(data) {
  const channels = cleanChannels(data?.channels);
  const clipsMap = new Map((data?.clips || []).map((c) => [c.id, c]));
  const layouts = new Map(channels.map((ch) => [ch.id, getTimelineLayout(ch.items || [], { unsnapped: ch.unsnapped })]));
  const width = Number(data?.videoSize?.w) || 1920, height = Number(data?.videoSize?.h) || 1080;
  return { channels, clipsMap, layoutFor: (ch) => layouts.get(ch.id), width, height };
}

/** (screensharp2) The Scene clip under the playhead at `time` whose Scene films from its own camera (`rig.scene.camera`): { item, start, end }
 *  or null. The last such clip on top wins, as resolveRigAt picks the Scene a frame is drawn from. */
function ownCameraSceneAt(tl, time) {
  let found = null;
  for (const channel of tl.channels) {
    if (channel?.visible === false) continue;
    const layout = tl.layoutFor(channel) || [];
    (channel.items || []).forEach((item, i) => {
      const e = layout[i];
      if (!e || !item?.rig?.scene?.camera || time < e.startTime - 1e-6 || time > e.endTime + 1e-6) return;
      found = { item, start: e.startTime, end: e.endTime };
    });
  }
  return found;
}

/** (screensharp2) Where a Scene's own camera films from at timeline `time`, steered by the Camera layer's `proxy` as the world steers it
 *  (WorldRenderer.applyTime: a turn about what it looks at and the same share of the way there, its zoom a lens): { at, target, up, fov,
 *  reach } in metres, or null. `rest` is the Camera layer's distance at rest (world3dLayer.js), `aspect` the frame's. */
export function steeredSceneCamera(scene, proxy, { time, start = 0, end = Infinity, rest, aspect }) {
  const cam = scene?.camera;
  if (!cam) return null;
  const local = Math.max(0, Math.min(Math.max(0, end - start), time - start));
  const shot = cameraShot(cam, scene, [local], aspect)[0] || {};
  const at = new THREE.Vector3(...(Array.isArray(shot.at) ? shot.at : [0, 1, 3]));
  const target = new THREE.Vector3(...(Array.isArray(shot.target) ? shot.target : [0, 0, 0]));
  const c = new THREE.PerspectiveCamera(shot.view ?? shot.fov ?? 28, aspect || 16 / 9);
  c.position.copy(at);
  const d = target.clone().sub(at), reach = d.length() || 1;
  c.up.set(...(Array.isArray(cam.up) ? cam.up : (Math.abs(d.y) / reach > 0.999 ? [0, 0, -1] : [0, 1, 0])));
  c.lookAt(target);
  if (proxy && rest > 0) {
    const steer = worldSteer(proxy, rest);
    c.position.add(new THREE.Vector3().fromArray(steer.position).multiplyScalar(reach).applyQuaternion(c.quaternion));
    c.quaternion.multiply(new THREE.Quaternion().fromArray(steer.quaternion));
    c.fov = (2 * Math.atan(Math.tan((c.fov * Math.PI) / 360) / steer.zoom) * 180) / Math.PI;
  }
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(c.quaternion), up = new THREE.Vector3(0, 1, 0).applyQuaternion(c.quaternion);
  return { at: c.position.clone(), target: c.position.clone().addScaledVector(fwd, reach), up, fov: c.fov, reach,
    focus: Number.isFinite(shot.focus) ? shot.focus : null, fStop: Number.isFinite(shot.fStop) ? shot.fStop : 0 };
}

/** The camera clip under the playhead at `time`: { item, start, end } or null (the same pick as resolveCameraPose). */
function cameraClipAt(tl, time) {
  const channel = findCameraChannel(tl.channels);
  if (!channel || channel.visible === false) return null;
  const layout = tl.layoutFor(channel) || [];
  for (let i = channel.items.length - 1; i >= 0; i -= 1) {
    const e = layout[i];
    if (!e || time < e.startTime - 1e-6 || time > e.endTime + 1e-6) continue;
    if (!isCameraClip(tl.clipsMap.get(channel.items[i]?.clipId))) continue;
    return { item: channel.items[i], start: e.startTime, end: e.endTime };
  }
  return null;
}

/**
 * The Camera layer's shot at each of `times` (timeline seconds): [{ t, camera, mode, at, target, up, fov, lens, zoom, roll, dof, pose }].
 * `at` is where the camera stands and `target` the point it looks at (its aim where a path or rig aims, else along its view at the
 * comp plane's distance), metres in the Scene's axes; `up` its up; `fov` the vertical field of view (degrees) and `lens` the focal
 * length (mm) on the world's 36 mm film; `dof` { on, focus (m), fStop, aperture (px), blurLevel } the thin lens Final traces (Draft
 * blurs the same circles). `pose` is the Camera layer's own tracks as evaluated (camX … camRoll, camZoom, camPathT). With no camera clip
 * under the playhead the camera is the neutral one ({ camera: null }).
 * (screensharp2) Where the Scene under the playhead films from its own camera (`rig.scene.camera`), the shot is that camera's, at its
 * clip's time, steered by the Camera layer as the world steers it (`films: "scene"`, `scene`: the Scene item's id, `steered` when the
 * Camera layer has moved it off its rest); `dof` is then that camera's own thin lens (`fStop`, `focus`), which the world traces. Before, this said where the Camera layer alone would stand,
 * which no render films there.
 */
export function cameraLayerShot(data, times, { tl = cameraTimeline(data) } = {}) {
  const { width: W, height: H } = tl;
  const D = perspectiveDistance(H);
  const aspect = W / H;
  const fwd = new THREE.Vector3(), up = new THREE.Vector3();
  return (times || []).map((t) => {
    const time = Number(t) || 0;
    const hit = cameraClipAt(tl, time);
    const pose = resolveCameraPose(tl.channels, tl.clipsMap, tl.layoutFor, time, { width: W, height: H });
    const proxy = cameraProxyFromPose(pose || {}, W, H);
    fwd.set(0, 0, -1).applyQuaternion(proxy.quaternion);
    up.set(0, 1, 0).applyQuaternion(proxy.quaternion);
    const dofSettings = getCameraDofSettings(pose, D);
    const lens = worldLens(dofSettings, W, proxy.fov, aspect);
    const reach = Math.max(1, dofSettings.focusDistance);
    let at = proxy.position.clone().multiplyScalar(WORLD_UNITS);
    let target = proxy.position.clone().addScaledVector(fwd, reach).multiplyScalar(WORLD_UNITS);
    let fov = proxy.fov, films = 'cameraLayer', sceneId = null, steered = false, sceneLens = null;
    const own = ownCameraSceneAt(tl, time);
    if (own) {
      // the Camera layer's move steers the Scene's own camera (world3dLayer.js poseWorld: worldSteer), from the rest it has at no move
      const rest = (H * 0.5) / Math.tan((28 * Math.PI) / 180 / 2);
      const s = steeredSceneCamera(own.item.rig.scene, hit ? proxy : null, { time, start: own.start, end: own.end, rest, aspect });
      if (s) {
        const st = hit ? worldSteer(proxy, rest) : null;
        steered = !!st && (Math.hypot(...st.position) > 1e-6 || Math.abs(st.quaternion[3]) < 1 - 1e-9 || Math.abs(st.zoom - 1) > 1e-6);
        at = s.at; target = s.target; up.copy(s.up); fov = s.fov; films = 'scene'; sceneId = own.item.id;
        sceneLens = { on: s.fStop > 0, focus: r4(s.focus ?? s.reach), fStop: r4(s.fStop), aperture: 0, blurLevel: 0 };
      }
    }
    const out = {
      t: r6(time), camera: hit?.item?.id ?? null, mode: hit ? (hit.item.cameraMoveMode || (hit.item.cameraPath ? 'path' : 'free')) : null,
      films, ...(sceneId ? { scene: sceneId, steered } : {}),
      at: v3(at), target: v3(target), up: v3(up), fov: r4(fov), lens: r4(lensMmOf(fov, aspect)),
      zoom: r4(Number.isFinite(pose?.camZoom) && pose.camZoom > 0 ? pose.camZoom : 1),
      dof: sceneLens || { on: !!dofSettings.enabled && lens.fStop > 0, focus: r4(dofSettings.focusDistance * WORLD_UNITS), fStop: r4(lens.fStop || 0),
        aperture: r4(dofSettings.aperture), blurLevel: r4(dofSettings.blurLevel) },
      pose: pose ? Object.fromEntries(['camX', 'camY', 'camDolly', 'camTiltX', 'camTiltY', 'camRoll', 'camZoom', 'camPathT']
        .map((k) => [k, r4(Number(pose[k]) || 0)])) : null,
    };
    return out;
  });
}

/** The share of each box's corners the Camera layer has in frame at `time` ({ id, bbox } boxes in metres, as a still's
 *  `inspect.objects` gives them): [{ id, fraction }]. */
export function cameraLayerInFrame(shot, objects, aspect) {
  const view = { at: shot.at, target: shot.target, up: shot.up, fov: shot.fov, aspect };
  return (objects || []).filter((o) => o?.bbox).map((o) => ({ id: o.id, fraction: cornersInFrame(o.bbox, view) }));
}
