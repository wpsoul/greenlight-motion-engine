/*
 * "How far is what the frame shows at (x, y)": the camera's focus probe, out of the editor's Player (Player.jsx
 * probeFocusDepth, the Camera panel's focus pad and Pick in preview), so any page that runs the engine answers it from its
 * own renderer. Same rules: a ray from the neutral camera (the reference distance every depth-of-field figure reads) through
 * the frame point, the channels tested top to bottom on the meshes the last frame drew; a 3D model answers with its filmed
 * surface; a 3D Scene answers from its own world (world3dLayer.js worldDepthAt) and sorts by depth against the flat layers.
 * x, y: 0..1 of the frame (y down). Returns the distance along the camera's axis in frame px, or null over nothing.
 * The editor's Player and the standalone page (PlayerPage.jsx probeDepth) both answer through it, so they cannot drift.
 * `clipsMap` / `layoutMap`: a caller that already keeps them (the Player) passes its own; otherwise they are made here.
 */
import * as THREE from 'three';
import { isCameraChannel } from '../projectCamera';
import { worldDepthAt } from '../world3dLayer';
import { getTimelineLayout } from '../speedUtils';
import { resolveActiveIndex } from '../shutterHold';

export function probeFocusDepth(engine, { channels = [], clips = [], clipsMap = null, layoutMap = null, time = 0 } = {}, x, y) {
  const camera = engine?.camera;
  if (!camera) return null;
  const clipById = clipsMap || new Map((clips || []).map((c) => [c.id, c]));
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(new THREE.Vector2(x * 2 - 1, 1 - y * 2), camera);

  // Channels are stored bottom-to-top. Test them in reverse so a click chooses
  // the visually topmost transformed plane under the focus reticle.
  let hit = null;
  for (let i = channels.length - 1; i >= 0 && !hit; i--) {
    const channel = channels[i];
    if (channel.visible === false || isCameraChannel(channel)) continue;
    const cs = engine.channelStates?.get(channel.id);
    if (!cs || cs.group.visible === false) continue;
    // A model's quad is a full-frame billboard at the origin, so its own depth says nothing about the model. The
    // surface does, and a click past it is a click on whatever is behind.
    const layout = layoutMap ? layoutMap.get(channel.id) : getTimelineLayout(channel.items || [], { unsnapped: channel.unsnapped });
    const index = layout ? resolveActiveIndex(layout, time) : -1;
    if (engine.worldFrameReady && (channel.kind === 'rig' || clipById.get(channel.items[index]?.clipId)?.mediaType === 'model3d')) continue;
    const filmed = index >= 0 ? engine.model3d?.pickFilmedDepth?.(channel.items[index]?.id, x, y) : undefined;
    if (filmed !== undefined) {
      if (filmed > 0) return filmed;
      continue;
    }
    cs.rig?.updateMatrixWorld(true);
    for (const mesh of [cs.currMesh, cs.prevMesh]) {
      if (!mesh?.visible) continue;
      const intersections = raycaster.intersectObject(mesh, false);
      if (intersections.length) {
        hit = intersections[0];
        break;
      }
    }
  }
  // The Scene sorts by depth against the flat layers, wherever it sits in the stack.
  const world = engine.worldFrameReady ? worldDepthAt(x, y) : null;
  if (!hit) return world;
  const cameraPosition = camera.getWorldPosition(new THREE.Vector3());
  const cameraDirection = camera.getWorldDirection(new THREE.Vector3());
  const distance = hit.point.clone().sub(cameraPosition).dot(cameraDirection);
  if (!(distance > 0)) return world;
  return world !== null ? Math.min(distance, world) : distance;
}
