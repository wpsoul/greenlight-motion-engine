/*
 * Layer warps and the Motion Trail draw (PLANS/GREENLIGHT_MOTION_ENGINE_PLAN.md, Stage 9 step 12 — moved verbatim out
 * of the Player, `xRef.current` → `engine.x`): each draws a layer's finished plate (`srcTarget`) into `outTarget`
 * through its own warp pass, built on first use, over the layer's projected box (computeLayerBox). A degenerate box
 * — the layer edge-on or scaled to nothing — returns `srcTarget` untouched.
 *
 * Engine fields: renderer, orthoCamera, the passes (regionDistortPass, bendPass, meshWarpPass, bezierWarpPass,
 * cornerPinPass, drostePass — released with the renderer), motionTrailScene (./effectPasses.js).
 */
import * as THREE from 'three';
import { squareToQuadHomography } from '../homography';
import { swapWarpMaterialForBackend } from '../materialFactory';
import { createRegionDistortPass, applyRegionDistortUniforms } from '../regionDistort';
import { createBendPass, applyBendUniforms } from '../bendLayer';
import { createMeshWarpPass, applyMeshWarpUniforms } from '../meshWarp';
import { createBezierWarpPass, applyBezierWarpUniforms } from '../bezierWarp';
import { createCornerPinPass, applyCornerPinUniforms } from '../cornerPinLayer';
import { createDrostePass, applyDrosteUniforms } from '../drosteLayer';
import { applyMotionTrailUniforms } from '../motionTrailLayer';
import { ensureMotionTrailMaterial } from './effectPasses';

const fxBoxVec = new THREE.Vector3();

// The box an effect works in, in the mesh's local units. Normally the quad itself;
// a video's quad is only its fitted picture, and its effects, masks and pins keep the
// frame-sized box they were authored against (layerMesh.js `fxFrame`).
function layerBoxBounds(mesh) {
  const bb = mesh.geometry.boundingBox;
  const k = mesh.userData?.fxFrame;
  if (!k) return bb;
  const cx = (bb.min.x + bb.max.x) / 2;
  const cy = (bb.min.y + bb.max.y) / 2;
  const hx = ((bb.max.x - bb.min.x) / 2) * k[0];
  const hy = ((bb.max.y - bb.min.y) / 2) * k[1];
  return { min: { x: cx - hx, y: cy - hy }, max: { x: cx + hx, y: cy + hy } };
}

export function computeLayerBox(mesh, camera, pixelW, pixelH) {
  if (!mesh || !camera || !mesh.geometry) return null;
  const geo = mesh.geometry;
  if (!geo.boundingBox) geo.computeBoundingBox();
  if (!geo.boundingBox) return null;
  const bb = layerBoxBounds(mesh);
  mesh.updateWorldMatrix(true, false);
  const project = (lx, ly) => {
    fxBoxVec.set(lx, ly, 0).applyMatrix4(mesh.matrixWorld).project(camera);
    return [fxBoxVec.x * 0.5 + 0.5, fxBoxVec.y * 0.5 + 0.5];
  };
  const cx = (bb.min.x + bb.max.x) / 2;
  const cy = (bb.min.y + bb.max.y) / 2;
  const origin = project(cx, cy);
  const edgeX = project(bb.max.x, cy);
  const edgeY = project(cx, bb.max.y);
  const axisX = [edgeX[0] - origin[0], edgeX[1] - origin[1]];
  const axisY = [edgeY[0] - origin[0], edgeY[1] - origin[1]];
  const sizeX = Math.hypot(axisX[0] * pixelW, axisX[1] * pixelH) * 2;
  const sizeY = Math.hypot(axisY[0] * pixelW, axisY[1] * pixelH) * 2;
  // Edge-on or scaled to nothing: no usable frame, and dividing by it would blow
  // the pattern up to infinity. Leave the effect on the plate.
  if (!(sizeX > 1) || !(sizeY > 1)) return null;
  // The plane's true PROJECTIVE map in the fx-helper convention (p = 0.5 + 0.5·local,
  // y up), from the four projected corners. The two-axis frame above is exact only for
  // a flat layer: under a 3D tilt the projected quad is a trapezoid the affine frame
  // cannot describe, and an effect painted on the affine box clips the layer's near
  // edge. Null (affine fallback) when the fit is degenerate.
  const fxHom = squareToQuadHomography(
    project(bb.min.x, bb.min.y),   // p (0,0)
    project(bb.max.x, bb.min.y),   // p (1,0)
    project(bb.max.x, bb.max.y),   // p (1,1)
    project(bb.min.x, bb.max.y),   // p (0,1)
  );
  return { origin, axisX, axisY, sizePx: [sizeX, sizeY], fxHom };
}

// Motion Trail: one pass over the layer's plate at its recalled poses. Returns srcTarget when there is nothing to
// draw with.
export function renderLayerMotionTrail(engine, srcTarget, outTarget, frame, flipPlate = false) {
  const renderer = engine.renderer;
  const orthoCamera = engine.orthoCamera;
  const material = ensureMotionTrailMaterial(engine);
  const scene = engine.motionTrailScene;
  if (!renderer || !orthoCamera || !scene || !material || !outTarget) return srcTarget;
  applyMotionTrailUniforms(material, frame.params, {
    width: srcTarget.width,
    height: srcTarget.height,
    boxNow: frame.boxNow,
    boxes: frame.boxes,
  });
  material.uniforms.uTexture.value = srcTarget.texture;
  if (material.uniforms.uFlipV) material.uniforms.uFlipV.value = flipPlate ? 1 : 0;
  renderer.setRenderTarget(outTarget);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, true, true);
  renderer.render(scene, orthoCamera);
  return outTarget;
}

// Region Distort: an inverse map over the layer's own box.
export function renderLayerRegionDistort(engine, srcTarget, outTarget, params, layerMesh, chCam, flipPlate = false, boxOverride = null) {
  const renderer = engine.renderer;
  if (!renderer || !layerMesh || !chCam) return srcTarget;
  const box = boxOverride || computeLayerBox(layerMesh, chCam, srcTarget.width, srcTarget.height);
  if (!box) return srcTarget;
  let pass = engine.regionDistortPass;
  if (!pass) {
    pass = swapWarpMaterialForBackend('regionDistort', createRegionDistortPass());
    engine.regionDistortPass = pass;
  }
  pass.material.uniforms.uTexture.value = srcTarget.texture;
  if (pass.material.uniforms.uFlipV) pass.material.uniforms.uFlipV.value = flipPlate ? 1 : 0;
  applyRegionDistortUniforms(pass.material, params, box);
  renderer.setRenderTarget(outTarget);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, true, true);
  renderer.render(pass.scene, engine.orthoCamera);
  return outTarget;
}

// Bend: the same plate drawn through a warped 128² grid — a forward map, so it
// displaces vertices rather than resolving a source per fragment.
export function renderLayerBend(engine, srcTarget, outTarget, params, layerMesh, chCam, flipPlate = false, boxOverride = null) {
  const renderer = engine.renderer;
  if (!renderer || !layerMesh || !chCam) return srcTarget;
  const box = boxOverride || computeLayerBox(layerMesh, chCam, srcTarget.width, srcTarget.height);
  if (!box) return srcTarget;
  let pass = engine.bendPass;
  if (!pass) {
    pass = swapWarpMaterialForBackend('bend', createBendPass());
    engine.bendPass = pass;
  }
  pass.material.uniforms.uTexture.value = srcTarget.texture;
  if (pass.material.uniforms.uFlipV) pass.material.uniforms.uFlipV.value = flipPlate ? 1 : 0;
  applyBendUniforms(pass.material, params, box);
  renderer.setRenderTarget(outTarget);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, true, true);
  renderer.render(pass.scene, engine.orthoCamera);
  return outTarget;
}

// Mesh Warp: the plate drawn through a Catmull-Rom lattice over the same 128² grid
// Bend uses — another forward map, so it displaces vertices too.
export function renderLayerMeshWarp(engine, srcTarget, outTarget, params, layerMesh, chCam, flipPlate = false, boxOverride = null) {
  const renderer = engine.renderer;
  if (!renderer || !layerMesh || !chCam) return srcTarget;
  const box = boxOverride || computeLayerBox(layerMesh, chCam, srcTarget.width, srcTarget.height);
  if (!box) return srcTarget;
  let pass = engine.meshWarpPass;
  if (!pass) {
    pass = swapWarpMaterialForBackend('meshWarp', createMeshWarpPass());
    engine.meshWarpPass = pass;
  }
  pass.material.uniforms.uTexture.value = srcTarget.texture;
  if (pass.material.uniforms.uFlipV) pass.material.uniforms.uFlipV.value = flipPlate ? 1 : 0;
  applyMeshWarpUniforms(pass, params, box);
  renderer.setRenderTarget(outTarget);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, true, true);
  renderer.render(pass.scene, engine.orthoCamera);
  return outTarget;
}

// Bezier Warp: the plate drawn through a Coons patch built from four cubic edges —
// forward, like Mesh Warp, and over the same grid.
export function renderLayerBezierWarp(engine, srcTarget, outTarget, params, layerMesh, chCam, flipPlate = false, boxOverride = null) {
  const renderer = engine.renderer;
  if (!renderer || !layerMesh || !chCam) return srcTarget;
  const box = boxOverride || computeLayerBox(layerMesh, chCam, srcTarget.width, srcTarget.height);
  if (!box) return srcTarget;
  let pass = engine.bezierWarpPass;
  if (!pass) {
    pass = swapWarpMaterialForBackend('bezierWarp', createBezierWarpPass());
    engine.bezierWarpPass = pass;
  }
  pass.material.uniforms.uTexture.value = srcTarget.texture;
  if (pass.material.uniforms.uFlipV) pass.material.uniforms.uFlipV.value = flipPlate ? 1 : 0;
  applyBezierWarpUniforms(pass, params, box);
  renderer.setRenderTarget(outTarget);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, true, true);
  renderer.render(pass.scene, engine.orthoCamera);
  return outTarget;
}

// Corner Pin: the plate read through a projective homography — an inverse map like
// Region Distort, so it shares the cheap single-quad geometry.
export function renderLayerCornerPin(engine, srcTarget, outTarget, params, layerMesh, chCam, flipPlate = false, boxOverride = null) {
  const renderer = engine.renderer;
  if (!renderer || !layerMesh || !chCam) return srcTarget;
  const box = boxOverride || computeLayerBox(layerMesh, chCam, srcTarget.width, srcTarget.height);
  if (!box) return srcTarget;
  let pass = engine.cornerPinPass;
  if (!pass) {
    pass = swapWarpMaterialForBackend('cornerPin', createCornerPinPass());
    engine.cornerPinPass = pass;
  }
  pass.material.uniforms.uTexture.value = srcTarget.texture;
  if (pass.material.uniforms.uFlipV) pass.material.uniforms.uFlipV.value = flipPlate ? 1 : 0;
  applyCornerPinUniforms(pass.material, params, box);
  renderer.setRenderTarget(outTarget);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, true, true);
  renderer.render(pass.scene, engine.orthoCamera);
  return outTarget;
}

// Droste: the plate read through the Escher map — an inverse map like Corner Pin and
// Region Distort, so it shares their cheap single-quad geometry. It is the only warp
// whose quad is NOT overscanned: the fold resolves every point inside the box, and a
// Droste resamples the layer rather than displacing it past its own bounds.
//
// `localTime` is CLIP-LOCAL seconds. Zoom Speed / Spin Speed are rates and are
// deliberately not keyframable, so unlike Repetile's scroll they need no integral —
// the offset is just t·speed (see drosteMotion).
export function renderLayerDroste(engine, srcTarget, outTarget, params, layerMesh, chCam, localTime, flipPlate = false, boxOverride = null) {
  const renderer = engine.renderer;
  if (!renderer || !layerMesh || !chCam) return srcTarget;
  const box = boxOverride || computeLayerBox(layerMesh, chCam, srcTarget.width, srcTarget.height);
  if (!box) return srcTarget;
  let pass = engine.drostePass;
  if (!pass) {
    pass = swapWarpMaterialForBackend('droste', createDrostePass());
    engine.drostePass = pass;
  }
  pass.material.uniforms.uTexture.value = srcTarget.texture;
  if (pass.material.uniforms.uFlipV) pass.material.uniforms.uFlipV.value = flipPlate ? 1 : 0;
  applyDrosteUniforms(pass.material, params, box, localTime);
  renderer.setRenderTarget(outTarget);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, true, true);
  renderer.render(pass.scene, engine.orthoCamera);
  return outTarget;
}

// The layer plane's full PROJECTIVE map and its size ON THE PLANE, for Mockup Frame.
// `hom` maps box uv (y down) -> frame uv, fitted to the four projected corners of the
// mesh's box; the two-axis frame above is that map with the perspective terms dropped
// — exact for a flat layer, wrong the moment the layer tilts in 3D. `sizePlane` is the
// box measured in the plane's own pixels (its world size, as the camera would see it
// face-on at the box centre's depth): the projected midline lengths in `sizePx` shrink
// with every tilt, and a chassis laid out in that unit stretches across the plane while
// the artwork's cover-fit over-zooms. For an untilted layer at the frame plane the two
// agree exactly. Returns null when the box is degenerate or the camera has no frustum.
const _pbVec = new THREE.Vector3();
const _pbScale = new THREE.Vector3();
export function layerPlaneBox(mesh, camera, pixelH) {
  if (!mesh || !camera || !mesh.geometry?.boundingBox) return null;
  const bb = layerBoxBounds(mesh);
  const project = (lx, ly) => {
    _pbVec.set(lx, ly, 0).applyMatrix4(mesh.matrixWorld).project(camera);
    return [_pbVec.x * 0.5 + 0.5, _pbVec.y * 0.5 + 0.5];
  };
  const hom = squareToQuadHomography(
    project(bb.min.x, bb.max.y),   // box uv (0,0) = top-left
    project(bb.max.x, bb.max.y),   // (1,0)
    project(bb.max.x, bb.min.y),   // (1,1)
    project(bb.min.x, bb.min.y),   // (0,1)
  );
  if (!hom) return null;
  let sizePlane = null;
  let pxPerWorld = 0;
  if (camera.isPerspectiveCamera && pixelH > 0) {
    _pbScale.setFromMatrixScale(mesh.matrixWorld);
    const wW = (bb.max.x - bb.min.x) * Math.abs(_pbScale.x);
    const wH = (bb.max.y - bb.min.y) * Math.abs(_pbScale.y);
    _pbVec.set((bb.min.x + bb.max.x) / 2, (bb.min.y + bb.max.y) / 2, 0)
      .applyMatrix4(mesh.matrixWorld).applyMatrix4(camera.matrixWorldInverse);
    const depth = -_pbVec.z;
    if (depth > camera.near) {
      const frameH = 2 * depth * Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5) / (camera.zoom || 1);
      const k = pixelH / frameH;
      if (wW * k > 1 && wH * k > 1) { sizePlane = [wW * k, wH * k]; pxPerWorld = k; }
    }
  }
  return { hom, sizePlane, pxPerWorld };
}
