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
import { WORLD_UNITS, worldLens } from './world3dScene.js';

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
    const at = proxy.position.clone().multiplyScalar(WORLD_UNITS);
    const target = proxy.position.clone().addScaledVector(fwd, reach).multiplyScalar(WORLD_UNITS);
    const out = {
      t: r6(time), camera: hit?.item?.id ?? null, mode: hit ? (hit.item.cameraMoveMode || (hit.item.cameraPath ? 'path' : 'free')) : null,
      at: v3(at), target: v3(target), up: v3(up), fov: r4(proxy.fov), lens: r4(lensMmOf(proxy.fov, aspect)),
      zoom: r4(Number.isFinite(pose?.camZoom) && pose.camZoom > 0 ? pose.camZoom : 1),
      dof: { on: !!dofSettings.enabled && lens.fStop > 0, focus: r4(dofSettings.focusDistance * WORLD_UNITS), fStop: r4(lens.fStop || 0),
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
