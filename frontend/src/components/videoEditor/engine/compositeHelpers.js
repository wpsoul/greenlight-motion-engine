/*
 * Compositing helpers the render loop shares (PLANS/GREENLIGHT_MOTION_ENGINE_PLAN.md, Stage 9 step 23 — moved verbatim
 * out of Player.jsx with tests/engine-extraction/tools/move_module_decls.py, which the Player imports back): the
 * camera's field of view, the depth-of-field scratch, channel order, clip masks, upright isolates, a channel's active
 * item, a Glass layer's settings, and suspending a channel's blend while it is drawn alone.
 */
import * as THREE from 'three';
import { effectWindowAt } from '../adjustmentEffects';
import { resumeBlendMode, suspendBlendMode } from '../clipShader';
import { tieCoplanar } from '../compositeSortDepth';
import { depthScanPhase, getDepthScanEffect, resolveDepthScanParams } from '../depthScanLayer';
import { getFresnelRimEffect, isFresnelRimEnabled, resolveFresnelRimParams } from '../fresnelRimLayer';
import { glassShapeOf, resolveGlassParams } from '../glassEffect';
import { applyGsapEasing } from '../gsapTransitions';
import { resolveModelOverlayFx } from '../model3dFxCatalog';
import { perfRegistry } from '../perfRegistry.js';
import { isCameraBaked3dPlate, RIG_CHANNEL_KIND, RIG_MEDIA_TYPE } from '../rig3d';
import { shapeBoxSize, shapeCornerRadii, withShapeSizeKeyframes } from '../shapePath';
import { shapePlateAt } from './meshTransform';
import { PREVIEW_TIER } from './previewMedia';

// A channel's clip materials with their hardware blend mode suspended while the
// layer is drawn ALONE into a plate (see suspendBlendMode in clipShader.js).
// Always paired: resume puts the fast direct draw's blend back.
export function suspendChannelBlend(cs) {
  if (!cs) return;
  suspendBlendMode(cs.currMaterial);
  suspendBlendMode(cs.prevMaterial);
}

export function resumeChannelBlend(cs) {
  if (!cs) return;
  resumeBlendMode(cs.currMaterial);
  resumeBlendMode(cs.prevMaterial);
}

export const CAMERA_FOV = 28;

export function resolveActiveIndex(layout, time) {
  // Small epsilon so float rounding exactly at a shot boundary doesn't momentarily
  // resolve to no clip (which would blank the channel for a frame). Inclusive bounds
  // bias toward the incoming clip at an exact boundary, which is what we want.
  const EPS = 1e-6;
  for (let i = layout.length - 1; i >= 0; i -= 1) {
    if (time >= layout[i].startTime - EPS && time <= layout[i].endTime + EPS) return i;
  }
  return -1;
}

// A layer acts as a clipping mask when its own mask flag is on. Shapes and text
// both qualify — the mask pass only samples the channel's alpha, so any layer that
// rasterises a silhouette works the same way.
export function isClipMaskItem(clip, item) {
  if (!clip || !item) return false;
  if (clip.mediaType === 'shape') return !!item.shapeClipMask;
  if (clip.mediaType === 'text') return !!item.textClipMask;
  return false;
}

export function getChannelsBottomToTop(channels) {
  // Timeline rows are displayed in reverse, but Player z-order is the raw array:
  // earlier channels are lower, later channels are higher. The mask/adjustment
  // compositor must accumulate in this same bottom-to-top order.
  return channels;
}

// Scratch vectors for the per-layer DOF depth probe: it runs for every visible layer
// on every frame, so it must not allocate.
export const _dofWorld = new THREE.Vector3();

export const _dofView = new THREE.Vector3();

// Compositing order.
//
// Channel order is a TIMELINE concern; what occludes what is decided by depth. Visual
// layers are therefore composited back-to-front by their view-space distance, so a
// layer with a nearer panZ really does come forward past a layer on a higher channel.
//
// Adjustment layers and clip masks are the deliberate exception: they are defined as
// "everything BELOW me in the stack", so they act as barriers. Everything beneath one
// is flushed into the accumulation buffer before it runs, which keeps its meaning
// exactly as it is today. The consequence — two layers separated by an adjustment
// cannot sort against each other — is the direct price of that exception, and it
// matches how an adjustment layer behaves as a compositing boundary elsewhere.
//
// Ties keep channel order, and every layer defaults to panZ 0, so a project with no
// depth authored sorts precisely as it always has.
// The Rig channel is the one exception to the exception. It is pinned near the TOP of
// the stack (directly under the camera) because a set and its lens read as one block
// in the timeline — but a cyclorama is the BACKDROP, so it must composite first. Depth
// sorting would normally get that right on its own, since the cyclorama is the farthest
// thing in the frame; an adjustment layer or clip mask anywhere below it is a sort
// barrier, and the rig would then land on top of everything under that barrier and
// paint the comp out. Hoisting it here keeps its timeline position independent of what
// it draws behind.
// planeOf (optional): a channel → the plane its layer lies on (layerPlane) — layers sharing a tilted plane (a card
// rotated in 3D and what lies on it) sort as one, keeping their channel order (compositeSortDepth.js).
export function orderChannelsForComposite(channels, adjById, depthOf, planeOf) {
  const out = [];
  let run = [];
  const flush = () => {
    if (run.length > 1) {
      const entries = run.map((channel, i) => ({ channel, i, d: depthOf(channel), plane: planeOf ? planeOf(channel) : null }));
      if (planeOf) tieCoplanar(entries);
      run = entries
        // Farthest first: later draws land on top.
        .sort((a, b) => (b.d - a.d) || (a.i - b.i))
        .map((e) => e.channel);
    }
    for (const c of run) out.push(c);
    run = [];
  };
  for (const channel of channels) {
    if (channel.kind === RIG_CHANNEL_KIND) out.push(channel);
  }
  for (const channel of channels) {
    if (channel.kind === RIG_CHANNEL_KIND) continue;
    // A camera-LOCKED channel is a sort barrier for the same reason an adjustment
    // layer is, and this one is not a nicety — it is a correctness bug without it.
    //
    // cameraForChannel films a locked channel with the NEUTRAL camera and every
    // other channel with the POSED one. Their depths are therefore measured from
    // two different cameras, so sorting them against each other compares
    // distances that do not live in the same space. The moment the posed camera
    // dollies back (camDolly < 0) every layer that follows it sorts BEHIND a
    // locked layer that never moved — and a locked full-frame plate is opaque, so
    // everything else in the comp vanishes mid-shot. Exactly what a tracked
    // camera does: reproduce a shot that dollies, and the overlays disappear when
    // its dolly crosses zero.
    //
    // Treating it as a barrier gives After Effects' rule: a 2D layer breaks the
    // run of 3D layers and composites in STACKING order, while the 3D layers on
    // either side still sort among themselves.
    if (adjById.has(channel.id) || channel.cameraLocked) { flush(); out.push(channel); }
    else run.push(channel);
  }
  flush();
  return out;
}

// The layer's quad in the plate's own uv space — the coordinate frame a layer
// effect runs in. The chain always works on a full-frame plate, so without this
// every effect would centre and phase itself on the FRAME: the pattern stands
// still while the shape slides through it, which reads as a window-sized effect
// cut out by the layer instead of an effect painted on it.
//
// Projecting the plane's centre and its +x/+y edge midpoints through the same
// camera the isolate was rendered with folds position, scale, rotation and the
// camera rig into one affine frame in a single step. Returns the centre plus the
// two half-axes (frame uv) and the box's size in plate pixels, or null when the
// quad is degenerate or missing — the chain then falls back to the frame.
/* Whether a layer's isolate starts UPRIGHT (quad axis) rather than camera-axis.
   A model / Rig plate does: the 3D pass's tone step samples at screenUV
   (model3dNodes.js), which is why setupMesh skips its uInputFlipV and
   createMatteClipNodeMaterial reads its matte plain. Every per-layer stage that
   treats the isolate as camera-axis — the chain's opening blit, DOF, Running
   Glow — flipped it on WebGPU, and the plain matte then cut the mirrored picture
   down to its overlap with the upright silhouette. WebGL: no-op either way.
   A picture that RECEIVES shadows is filmed through the same tone step, so with
   its item it counts too (isCameraBaked3dPlate) — without the item it cannot be
   told apart from an ordinary picture. */
export function isUprightIsolatePlate(clip, item = null) {
  return clip?.mediaType === 'model3d' || clip?.mediaType === RIG_MEDIA_TYPE
    || (item != null && isCameraBaked3dPlate(clip, item));
}

// A glass shape's outline in local px + this frame's material (glassEffect.js),
// resolved at the same keyframe values and composition size the channel sizes
// its plate with — the pass maps local px onto that plate.
export function resolveGlassLayer(item, kf, compositionWidth, compositionHeight) {
  const shapeItem = withShapeSizeKeyframes(item, kf);
  const { width, height } = shapeBoxSize(shapeItem, compositionWidth, compositionHeight);
  const radii = shapeCornerRadii(shapeItem, width, height);
  const [plateW, plateH] = shapePlateAt(item, kf, compositionWidth, compositionHeight);
  return {
    shape: glassShapeOf(item, width, height, radii, plateW, plateH),
    m: resolveGlassParams(item, kf, Math.min(width, height)),
  };
}

// Scratch for decomposing a plate layer's world matrix (see promotePlateMesh).
export const _platePos = new THREE.Vector3();

// Pose `mesh` so its artwork sits where the chassis screen wants it (see
// mockupSeatTransform), for the isolate render only. Returns the saved pose for
// unseatLayerMesh, or null when the seat cannot be expressed. The seat acts in the
// layer's plane AFTER its own scale, so it composes as scale * k, an extra local Z
// rotation (Euler XYZ applies Z first) and a position offset rotated by the pose.
export const _seatOff = new THREE.Vector3();

export const _seatParent = new THREE.Vector3();

export function seatLayerMesh(mesh, seat, pxPerWorld) {
  if (!mesh || !seat || !(pxPerWorld > 0)) return null;
  if (!(seat.kx > 1e-6) || !(seat.ky > 1e-6) || ![seat.tx, seat.ty, seat.theta].every(Number.isFinite)) return null;
  const saved = { position: mesh.position.clone(), rotationZ: mesh.rotation.z, scale: mesh.scale.clone() };
  let parentScale = 1;
  if (mesh.parent) {
    _seatParent.setFromMatrixScale(mesh.parent.matrixWorld);
    parentScale = Math.abs(_seatParent.x) > 1e-9 ? Math.abs(_seatParent.x) : 1;
  }
  // plane px (y down) -> the mesh's post-scale local units (y up)
  const k = pxPerWorld * parentScale;
  _seatOff.set(seat.tx / k, -seat.ty / k, 0).applyQuaternion(mesh.quaternion);
  mesh.position.add(_seatOff);
  mesh.rotation.z -= seat.theta;   // y-down angle -> y-up
  mesh.scale.x *= seat.kx;
  mesh.scale.y *= seat.ky;
  mesh.updateMatrixWorld(true);
  return saved;
}

export function unseatLayerMesh(mesh, saved) {
  if (!mesh || !saved) return;
  mesh.position.copy(saved.position);
  mesh.rotation.z = saved.rotationZ;
  mesh.scale.copy(saved.scale);
  mesh.updateMatrixWorld(true);
}

// The frame-uv AABB of a projected layer box (null box = the whole frame),
// shrunk toward its centre by `insetPct` percent. Copy Color Profile's stats
// passes sample inside it, so a small reference layer gets dense taps instead of
// a frame-wide grid that mostly lands on transparency.

export const NEXT_CLIP_PRELOAD_WINDOW = 1.5;

// How long after a clip handoff the incoming element keeps the tight (0.08s)
// resync policy. The window self-clears the moment the element converges, so
// the only cost of a wide window is a corrective seek that SHOULD happen; but
// an expired window hands drift control back to the 0.5s audible tolerance.
// 180ms proved shorter than a cold re-source (300-400ms measured), letting a
// bare cross-channel cut start playing from a stale position uncorrected.
/*
 * Ease a layer entrance or exit FORWARD IN TIME.
 *
 * applyLayerTransition's `progress` is "how present the layer is": 1 → 0 across
 * an exit, so the ramp handed in already descends. Easing that descending value
 * directly plays the curve backwards, which mirrors it: an exit asked to "Ease
 * In" decelerated to a standstill on its last frame and one asked to "Ease Out"
 * accelerated — each the opposite of its name, and neither matching the OUT
 * previews in the picker (which have always eased forward) or the package path
 * (same). Easing time and flipping afterwards makes the name describe the
 * frames: an accelerating curve now flies the layer out at full speed on the
 * last frame, and with "Blur over time → Follow speed" that is where the blur
 * peaks instead of falling to nothing.
 *
 * Symmetric curves — Smooth, the default, and every other *In Out* — satisfy
 * ease(1−t) === 1−ease(t), so they are byte-identical either way and no project
 * resting on the default changes.
 */
export function easeLayerSlot(raw, easing, slot) {
  if (slot !== 'out') return applyGsapEasing(raw, easing);
  return 1 - applyGsapEasing(1 - raw, easing);
}

export const CLIP_HANDOFF_SYNC_MS = 500;

// Window before a hard cut in which the outgoing clip is pulled back onto the
// clip clock. Ordinary audible playback tolerates 0.5s of drift (a corrective
// seek flushes the element's audio pipeline), but at a cut that tolerance lets
// the tail free-run past its trim-out and show source material that is not in
// the edit — right where the eye is fixed on the boundary.
export const CLIP_BOUNDARY_CONVERGE_S = 0.25;

export const IDLE_CHANNEL_PRELOAD_LEAD = PREVIEW_TIER.preloadPolicy.idleLeadSec;
perfRegistry.tier = PREVIEW_TIER.name;

export const _modelSize = new THREE.Vector2();

export const _plateQuat = new THREE.Quaternion();

export const _plateScale = new THREE.Vector3();

/* The per-layer effects that BAKE into a clip's plate before a transition, with the
   same exclusions their compositor collectors apply. A layer effect is part of the
   layer: the transition must move/wipe the effected plate, never the bare artwork —
   and an executable transition package hides the clip planes outright, so anything
   not baked here vanishes for exactly the length of the transition. Motion Blur and
   Motion Trail stay in the compositor (they measure the channel's own pose history). */
/*
 * The real-3D effects a MODEL layer carries this frame, in the shape
 * model3dFx.runModelFx takes: [{ id, params }]. Every gate the flat passes use
 * applies — muted, Amount 0 or outside the Active Range means the entry is not
 * in the list at all — so a layer whose effects are all idle never loads the
 * effects module or allocates a target. Inside a window the clock is rebased,
 * exactly as Depth Scan does it.
 */
export function resolveModelFx3d(item, kfNow, clipNow, duration) {
  const out = [];
  // Depth Scan on a model slices EXACT depth inside the 3D pass — no depth map.
  const scan = getDepthScanEffect(item);
  if (scan && scan.enabled !== false) {
    const params = resolveDepthScanParams(item, kfNow);
    const win = effectWindowAt(scan, clipNow, duration);
    if (params.scnAmount > 0.01 && (!win || win.amount > 0)) {
      const sweepNow = win ? win.time : clipNow;
      const space = Number(scan.params?.scnSpace);
      out.push({
        id: 'depthScan',
        params: { ...params, scnSpace: [1, 2, 3].includes(space) ? space : 0 },
        phase: depthScanPhase(params, sweepNow),
        time: sweepNow,
      });
    }
  }
  if (isFresnelRimEnabled(item, 'model3d')) {
    const win = effectWindowAt(getFresnelRimEffect(item), clipNow, duration);
    if (!win || win.amount > 0) {
      out.push({ id: 'fresnelRim', params: resolveFresnelRimParams(item, kfNow), time: win ? win.time : clipNow });
    }
  }
  // Overlay Effects added to the model in 3D (`real3d`), after the layer
  // effects — the flat stack's order (layer stages, then the chain).
  const master = Number.isFinite(kfNow?.effectAmount) ? Math.max(0, Math.min(1, kfNow.effectAmount)) : 1;
  out.push(...resolveModelOverlayFx(item, { kf: kfNow, time: clipNow, duration, master }));
  return out.length ? out : null;
}

export const PERF_SAMPLE_MS = 800;

export function getPerspectiveDistance(height, fovDeg = CAMERA_FOV) {
  const fovRad = THREE.MathUtils.degToRad(fovDeg);
  return (height * 0.5) / Math.tan(fovRad * 0.5);
}
