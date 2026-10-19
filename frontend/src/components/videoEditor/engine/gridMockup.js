/*
 * Grid cells and Mockup Frame (PLANS/GREENLIGHT_MOTION_ENGINE_PLAN.md, Stage 9 step 18 — moved verbatim out of the
 * Player with tests/engine-extraction/tools/convert_leaf.py): a grid container's cell poses (its cells are real 3D
 * objects filmed by the composition's camera, below) and the grid guide, the world view's borrowed grids, and the
 * Mockup Frame pass (a device chassis drawn around a layer, laid out on the layer's real plane).
 *
 * Engine fields: renderer, camera, orthoCamera, videoSize, exporting, renderFrame, worldGrids, mockupFramePass,
 * mockupChassis, mockupDensity, adaptiveRaster, rasterSupersample.
 */
import * as THREE from 'three';
import { gridKfOverrides, gridLayoutMixPoses, normalizeGridConfig } from '../gridLayout';
import { getItemKeyframeValues, integratePathRate, itemHasKeyframes } from '../gsapTransitions';
import { PARENTING_FULL_COPY, applyParenting, localPrs, resolveItemPrs, worldDeltaToLocal } from '../keyframeParenting';
import { materials as makeMaterial } from '../materialFactory';
import { applyMockupFrameUniforms, buildMockupDevice, createMockupFramePass, expandLayerBox, layoutMockupFrame, mockupChassisBoundsUv, mockupPassQuad, mockupShadowPad, resolveMockupFrameParams, updateMockupChassisCanvas } from '../mockupFrame';
import { VECTOR_DENSITY_BUCKETS, densityBytes, resolveDensity } from '../rasterDensity';
import { measureScreenScale } from '../rasterDensityProject';
import { composeViewRotation } from './camera';
import { computeLayerBox, layerPlaneBox } from './layerWarps';

// ── A grid's cells are REAL 3D objects ──
//
// A grid is a container like a sequence, but its content is a spatial
// arrangement — so flattening it into a transformed plate would destroy exactly
// what it is for: parallax between cells, a sphere the camera can orbit, depth
// it can dolly through. Instead the inner scene is filmed by the SAME camera
// that films the composition, moved into the grid's own space: with grid world
// matrix G, the inner camera is G⁻¹·C, and rendering the private scene through
// G⁻¹·C is mathematically identical to rendering G·scene through C. The
// finished buffer is then composited SCREEN-ALIGNED — identity plate, neutral
// lens — so it lands 1:1 in the frame.
//
// The plate becomes a pure intermediate: the grid item's filters, opacity,
// blend mode, masks and transitions still apply to it, but geometrically the
// cells behave as if they stood in the main scene. Consequences, deliberate:
// - The grid item's transform (and its keyframes) moves the ARRANGEMENT in 3D.
// - The project camera sees real parallax between cells at different depths.
// - "Face screen" aims each card at the actual lens, at any angle.
// - The world view shows the member meshes themselves, not a plate.
// Only a grid that is itself a CELL of another grid keeps plate semantics —
// its pose belongs to the outer layout (signalled by parentXform.cell).
const _gridMatA = new THREE.Matrix4();
const _gridMatB = new THREE.Matrix4();
const _gridVecP = new THREE.Vector3();
const _gridVecS = new THREE.Vector3();
const _gridEulerA = new THREE.Euler();
const _gridQuatA = new THREE.Quaternion();
const _gridCamPos = new THREE.Vector3();
const _gridCamQuat = new THREE.Quaternion();
const _gridCamScale = new THREE.Vector3();

export function buildGridCellPoses(engine, gridClip, item, localTime, absoluteTime, levelParentIndex, parentXform, cameraPose, baseCamera = null) {
  const channels = gridClip.sequence.channels;
  // Excluded members (channel hidden) take no cell — the layout closes up.
  const active = [];
  for (const ch of channels) {
    if (ch.visible === false || !ch.items?.length) continue;
    active.push({ id: ch.id, name: ch.name || '', item: ch.items[0] });
  }
  if (!active.length) return null;
  const trimStart = item.trimStart ?? 0;
  const trimEnd = Number.isFinite(item.trimEnd) ? item.trimEnd : gridClip.duration;
  const span = Math.max(0.001, trimEnd - trimStart);
  const progress = Math.max(0, Math.min(1, (localTime - trimStart) / span));
  // `gr:<key>` tracks animate the layout itself; everything else on the item
  // (opacity, filters, effects) stays on its ordinary evaluation path.
  const kf = itemHasKeyframes(item) ? getItemKeyframeValues(item, progress) : null;
  // `gr:` values as a map: merged over the base config here, and threaded to
  // gridLayoutMixPoses so they re-apply over each layout slot's geometry too —
  // a keyframed radius stays continuous straight through a type change.
  const gridKf = gridKfOverrides(kf);
  let config = normalizeGridConfig(item.gridConfig);
  if (gridKf) config = { ...config, ...gridKf };
  // Path mode rides the layer's OWN motion path unless the grid carries a curve
  // of its own. That is deliberate: it means the shipped on-canvas path editor
  // and its preset popover ARE the grid's path editor, with no second copy of
  // either — draw the curve on the grid layer and the cells follow it. The
  // grid's Follow Path toggle stays independent, so the arrangement only
  // travels along the curve if the user asks it to. With layout slots, ANY
  // path-mode slot rides it — the curve is shared config, and the other
  // modes simply ignore it.
  const usesPath = config.layouts?.length
    ? config.layouts.some((slot) => slot.mode === 'path')
    : config.mode === 'path';
  if (usesPath && !config.path && (item.motionPath?.points?.length || 0) >= 2) {
    config = { ...config, path: { points: item.motionPath.points, closed: item.motionPath.closed === true } };
  }
  const { w: W, h: H } = engine.videoSize;

  // ── Proximity sources ──
  // The referenced layers live on the grid's OWN editing level, in world space,
  // while the cells live inside the container's private scene — which the
  // grid's own transform is applied to afterwards. So a source has to be
  // brought into the grid's local frame, or the influence would drift the
  // moment the grid itself moves, rotates or scales.
  // The grid's OWN resolved transform — its stored PRS plus whatever it is
  // parented to. The proximity conversion, "Face screen" and the inner camera
  // all need it.
  const gridLocal = localPrs(item, kf, W, H);
  const gridPrs = parentXform ? applyParenting(parentXform.prs, gridLocal, parentXform.type) : gridLocal;

  let proximitySources = null;
  if (config.effector === 'proximity' && config.proxSources.length && levelParentIndex) {
    const kfCtx = { W, H, evalKeyframes: getItemKeyframeValues };
    proximitySources = config.proxSources.map((id) => {
      if (id === item.id) return null;                 // a grid cannot attract itself
      const prs = resolveItemPrs(levelParentIndex, id, absoluteTime, kfCtx);
      if (!prs) return null;
      const d = worldDeltaToLocal(gridPrs, prs.px - gridPrs.px, prs.py - gridPrs.py, prs.pz - gridPrs.pz);
      return { x: d.x, y: d.y, z: d.z };
    }).filter(Boolean);
  }

  const camZ = engine.camera?.position?.z;
  // ── Real 3D ──
  // Any grid that is not itself a cell of another grid: the composition's own
  // camera is moved into the grid's space (G⁻¹·C — identical to filming
  // G·scene through C), so the cells are genuine 3D objects to the project
  // camera. The layout gets the lens's true position, up and forward axis in
  // grid space, and there is nothing left on the plate to pre-cancel.
  const real3d = !parentXform?.cell && !!baseCamera;
  let innerCam = null;
  let cameraPos = null;
  let cameraUp = null;
  let cameraDir = null;
  if (real3d) {
    const s = Math.abs(gridPrs.sx) > 1e-6 ? gridPrs.sx : 1e-6;
    _gridMatA.compose(
      _gridVecP.set(gridPrs.px, gridPrs.py, gridPrs.pz),
      _gridQuatA.setFromEuler(_gridEulerA.set(gridPrs.rx, gridPrs.ry, gridPrs.rz, 'XYZ')),
      _gridVecS.set(s, s, s)
    );
    baseCamera.updateMatrixWorld();
    _gridMatB.copy(_gridMatA).invert().multiply(baseCamera.matrixWorld);
    _gridMatB.decompose(_gridCamPos, _gridCamQuat, _gridCamScale);
    innerCam = {
      position: _gridCamPos.clone(),
      quaternion: _gridCamQuat.clone(),
      scale: _gridCamScale.clone(),
      fov: baseCamera.fov,
    };
    cameraPos = { x: _gridCamPos.x, y: _gridCamPos.y, z: _gridCamPos.z };
    const up = _gridVecP.set(0, 1, 0).applyQuaternion(_gridCamQuat);
    cameraUp = { x: up.x, y: up.y, z: up.z };
    const fwd = _gridVecP.set(0, 0, -1).applyQuaternion(_gridCamQuat);
    cameraDir = { x: fwd.x, y: fwd.y, z: fwd.z };
  }

  const poses = gridLayoutMixPoses(config, active, {
    W, H, progress, duration: span,
    gridKfOverrides: gridKf,
    proximitySources,
    // A cell must never reach the lens — see the view-space clamp in gridLayout.
    cameraZ: camZ,
    cameraPos,
    cameraUp,
    cameraDir,
    // Plate mode (a grid living as a CELL of another grid): the outer layout's
    // cell pose still turns this grid's plate, so "Face screen" pre-cancels it.
    // In real-3D mode everything is folded into the camera — nothing to cancel.
    viewRotation: real3d ? null : composeViewRotation(cameraPose, gridPrs),
  });
  // ── Layout guide ──
  // "Show shape in view": a dashed line through the cell centres in LAYOUT
  // order (cellIndex, not member order), so the arrangement's shape — and
  // exactly which point a stagger/twist affects next — is visible while
  // authoring. Built from the final mixed poses, so it follows morphs,
  // keyframes and effector pushes for free.
  let guide = null;
  if (config.showGuide && poses.length > 1) {
    const pts = poses
      .map((p) => ({ i: p.cellIndex, x: p.prs.px, y: p.prs.py, z: p.prs.pz }))
      .sort((a, b) => a.i - b.i);
    // A staggered ring is a coil, not a loop — closing it would draw a seam
    // from the outermost cell back to the first.
    const closed = !config.layouts?.length && (
      (config.mode === 'radial' && config.rings === 1 && config.sweep >= 359.999 && config.radiusStagger === 0)
      || (config.mode === 'path' && config.path?.closed === true));
    guide = { points: pts, closed };
  }
  const byChannel = new Map();
  poses.forEach((pose, i) => {
    byChannel.set(active[i].id, {
      prs: pose.prs,
      type: PARENTING_FULL_COPY,
      // Everything setupMesh needs once the media's own size is known.
      cell: {
        w: pose.cellW,
        h: pose.cellH,
        fit: pose.fit,
        keepScale: pose.keepScale,
        keepRotation: pose.keepRotation,
        opacity: pose.opacity,
        // Per-cell filter deltas from the live effector (blur, brightness, …).
        // They land on the clip material after its own filters, because that is
        // where those values live.
        fx: pose.fx,
      },
    });
  });
  return { poses: byChannel, innerCam, guide };
}

export function updateGridGuide(engine, st, guide) {
  if (!guide || engine.exporting) {
    if (st.gridGuide) st.gridGuide.visible = false;
    return;
  }
  const { h: H } = engine.videoSize;
  if (!st.gridGuide) {
    const line = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({
      color: 0x8b76f0,
      transparent: true,
      opacity: 0.9,
      depthTest: false,
      depthWrite: false,
    }));
    line.renderOrder = 999;
    st.gridGuide = line;
    st.scene.add(line);
  }
  const line = st.gridGuide;
  line.material.dashSize = H * 0.016;
  line.material.gapSize = H * 0.01;
  const pts = guide.closed ? [...guide.points, guide.points[0]] : guide.points;
  const geo = line.geometry;
  let attr = geo.getAttribute('position');
  if (!attr || attr.array.length !== pts.length * 3) {
    attr = new THREE.BufferAttribute(new Float32Array(pts.length * 3), 3);
    geo.setAttribute('position', attr);
  }
  for (let i = 0; i < pts.length; i += 1) attr.setXYZ(i, pts[i].x, pts[i].y, pts[i].z);
  attr.needsUpdate = true;
  geo.computeBoundingSphere();
  line.computeLineDistances();
  line.visible = true;
}

export function returnBorrowedGrids(engine) {
  for (const lent of engine.worldGrids.values()) {
    try {
      lent.group.remove(lent.scene);
      lent.group.parent?.remove(lent.group);
    } catch { /* already home */ }
  }
  engine.worldGrids.clear();
}

// `env` carries three values the Player's callback closed over (and, with an empty dependency list, kept from its
// first render): getRasterCaps / getRasterBudget and interactivePreviewEnabled. Callers inside the engine leave it out
// and get engine.mockupEnv — the same first-render values, set once by the Player.
export function renderLayerMockupFrame(engine, srcTarget, outTarget, params, layerMesh, chCam, channelId, flipPlate = false, info = null, seated = false, env = engine.mockupEnv || {}) {
  const { getRasterCaps, getRasterBudget, interactivePreviewEnabled } = env;
  const renderer = engine.renderer;
  if (!renderer || !layerMesh || !chCam) return srcTarget;
  const box = computeLayerBox(layerMesh, chCam, srcTarget.width, srcTarget.height);
  if (!box) return srcTarget;
  // The chassis rides the layer's PLANE: a 3D tilt must keystone it exactly as it
  // keystones the artwork, so the pass maps through the plane's homography and lays
  // the chassis out in the plane's own pixels — not the flattened two-axis frame and
  // the foreshortened lengths the warps use.
  const plane = layerPlaneBox(layerMesh, chCam, srcTarget.height);
  if (plane) { box.hom = plane.hom; box.sizePlane = plane.sizePlane; }
  const size = box.sizePlane || box.sizePx;
  const boxW = Math.max(1, size[0]);
  const boxH = Math.max(1, size[1]);
  const dev = buildMockupDevice(params);
  if (!dev || !(dev.w > 0) || !(dev.h > 0)) return srcTarget;
  const layout = layoutMockupFrame(dev, boxW, boxH, params);
  if (!(layout.scale > 1e-6)) return srcTarget;
  const boundsUv = mockupChassisBoundsUv(dev, layout, mockupShadowPad(dev, params), boxW, boxH);
  if (info) info.box = expandLayerBox(box, boundsUv);
  const quad = box.hom ? mockupPassQuad(box.hom, boundsUv) : null;

  // PARITY WITH TEXT AND SHAPES. `layout.scale` is device units -> COMPOSITION px, so
  // on its own the chassis is drawn at composition resolution and a camera push or a
  // zoomed preview magnifies a fixed raster — which is the one thing this effect exists
  // not to do. Measure how much the layer is actually magnified on screen and draw the
  // chassis at that resolution, through the same density ladder, caps and memory budget
  // a shape uses. Hysteresis stays preview-only so an export is a pure function of the
  // frame.
  let density = 1;
  if (engine.adaptiveRaster) {
    const buffer = engine.renderer?.domElement;
    const screenScale = measureScreenScale(
      layerMesh, chCam, srcTarget.width, srcTarget.height, boxW, boxH,
      buffer?.width || 0, buffer?.height || 0,
    );
    const interactive = !engine.exporting;
    density = resolveDensity({
      screenScale,
      logicalW: boxW,
      logicalH: boxH,
      caps: getRasterCaps(),
      previous: interactive ? engine.mockupDensity.get(channelId) : null,
      interactive,
      // The VECTOR ladder, not the composition-plate one. A chassis is drawn from
      // paths, so at a small composition it is a handful of pixels wide and needs to
      // climb far past 4x to be sharp on screen — the same reason an SVG icon does.
      // Capping it at the text ladder is why a 720p project looked soft while a 4K
      // one looked fine: the plate was never allowed to out-resolve the composition.
      buckets: VECTOR_DENSITY_BUCKETS,
      maxDensity: interactivePreviewEnabled ? 4 : Infinity,
      supersample: engine.rasterSupersample,
    });
    // Step down until the chassis fits the texture-memory budget, exactly as vector
    // media does — the vector ladder reaches 32x, which is a lot of canvas.
    const budget = getRasterBudget();
    const bKey = `mf:${channelId}`;
    while (density > 1) {
      // Parity uses two full-size RGBA canvases/textures: punched body below
      // the media and glass/details above it. Count both against the budget.
      const bytes = densityBytes(dev.w, dev.h, density) * 2;
      if (budget.wouldFit(bKey, bytes)) break;
      const idx = VECTOR_DENSITY_BUCKETS.indexOf(density);
      density = idx > 0 ? VECTOR_DENSITY_BUCKETS[idx - 1] : 1;
    }
    if (density > 1) budget.note(bKey, densityBytes(dev.w, dev.h, density) * 2);
    else budget.release(bKey);
    if (interactive) engine.mockupDensity.set(channelId, density);
  }

  let state = engine.mockupChassis.get(channelId);
  if (!state) { state = { key: '', canvas: null, frontCanvas: null, texture: null, frontTexture: null }; engine.mockupChassis.set(channelId, state); }
  const redrew = updateMockupChassisCanvas(state, dev, params, [boxW, boxH], layout.scale * density);
  if (!state.canvas) return srcTarget;
  // A device switch resizes the canvas, and a resized canvas needs a NEW texture —
  // needsUpdate alone re-uploads at the old dimensions and leaves the previous
  // chassis showing through wherever the new one does not cover it.
  // A PAUSED preview renders exactly one frame per change, so anything that only
  // settles on a later frame (the density ladder stepping up, a freshly allocated
  // texture) would stay wrong until playback started drawing frames again — which is
  // exactly how this shipped. A redraw therefore asks for one more frame, guarded by
  // the key so it converges instead of looping.
  if (redrew && !engine.exporting && state.settleKey !== state.key) {
    state.settleKey = state.key;
    requestAnimationFrame(() => { engine.renderFrame?.(); });
  }
  if (!state.texture || state.texture.image !== state.canvas
    || state.texW !== state.canvas.width || state.texH !== state.canvas.height) {
    if (state.texture) state.texture.dispose();
    state.texture = new THREE.CanvasTexture(state.canvas);
    state.texW = state.canvas.width;
    state.texH = state.canvas.height;
    // NO colour-space tag, deliberately. Every other layer plate in this Player is an
    // untagged CanvasTexture, so the isolate carries sRGB-encoded bytes throughout.
    // Marking this one sRGB adds a linearisation nothing else does: the mid-grey
    // metals collapse to black and only the near-white highlights survive, which is
    // exactly how the chassis shipped — a black slab with bright hairlines.
    state.texture.premultiplyAlpha = false;   // straight alpha; the shader premultiplies
    state.texture.minFilter = THREE.LinearFilter;
    state.texture.magFilter = THREE.LinearFilter;
    state.texture.generateMipmaps = false;
  } else if (redrew) {
    state.texture.needsUpdate = true;
  }
  if (!state.frontTexture || state.frontTexture.image !== state.frontCanvas
    || state.frontTexW !== state.frontCanvas.width || state.frontTexH !== state.frontCanvas.height) {
    if (state.frontTexture) state.frontTexture.dispose();
    state.frontTexture = new THREE.CanvasTexture(state.frontCanvas);
    state.frontTexW = state.frontCanvas.width;
    state.frontTexH = state.frontCanvas.height;
    state.frontTexture.premultiplyAlpha = false;
    state.frontTexture.minFilter = THREE.LinearFilter;
    state.frontTexture.magFilter = THREE.LinearFilter;
    state.frontTexture.generateMipmaps = false;
  } else if (redrew) {
    state.frontTexture.needsUpdate = true;
  }

  let pass = engine.mockupFramePass;
  // Fast Refresh can preserve the old pass while replacing this module's shader
  // contract. Rebuild when a newly-added uniform is absent; production starts fresh,
  // but the editor must not crash during development either.
  if (!pass || !pass.material?.uniforms?.uSeated) {
    try { pass?.geometry?.dispose(); } catch { /* no-op */ }
    try { pass?.material?.dispose(); } catch { /* no-op */ }
    pass = createMockupFramePass(THREE);
    const nodeMat = makeMaterial.mockupFrame();
    if (nodeMat) {
      pass.material = nodeMat;
      pass.mesh.material = nodeMat;
    }
    engine.mockupFramePass = pass;
  }
  pass.material.uniforms.uTexture.value = srcTarget.texture;
  if (pass.material.uniforms.uFlipV) pass.material.uniforms.uFlipV.value = flipPlate ? 1 : 0;
  applyMockupFrameUniforms(pass.material, dev, params, layout, box, state.texture, state.frontTexture, state.pad || 0, quad, seated);
  renderer.setRenderTarget(outTarget);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, true, true);
  renderer.render(pass.scene, engine.orthoCamera);
  return outTarget;
}

export function resolveMockupStageParams(engine, fx, t) {
  const dur = fx.entry.endTime - fx.entry.startTime;
  const progress = dur > 0 ? Math.max(0, Math.min(1, (t - fx.entry.startTime) / dur)) : 0;
  const p = resolveMockupFrameParams(fx.item, getItemKeyframeValues(fx.item, progress));
  if (!(p.mfScrollX || p.mfScrollY)) return p;
  const now = t - fx.entry.startTime;
  const params = { ...p };
  if (p.mfScrollX) params.mfMediaX = p.mfMediaX - integratePathRate(fx.item, 'mfScrollSpeedX', p.mfScrollSpeedX, now, dur);
  if (p.mfScrollY) params.mfMediaY = p.mfMediaY - integratePathRate(fx.item, 'mfScrollSpeedY', p.mfScrollSpeedY, now, dur);
  return params;
}
