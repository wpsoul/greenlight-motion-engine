// (leftovers-rig) Dual-quaternion skinning in the editor's own WebGL pass: a model layer whose skeleton was made for it (world3d/rig,
// `skinning: "dualQuaternion"`, the default) draws outside a Scene through the editor's three, whose WebGLRenderer skins by linear blend.
// Its skinned meshes get materials of their own (clones) whose vertex shader blends the bones' table (world3d/rig/dualQuat.js: each bone's
// rigid part as a dual quaternion, its scale/shear part as three rows; 5 RGBA texels a bone, in the mesh's own space) instead: the same
// two phases as the world's raster (html/world3d-lab/threeNodePatches.mjs SKIN_DQ) and the tracer (applyBoneTransform), so this layer
// bends as it does in a Scene. Shadow maps draw through depth/distance materials made the same way. A mesh without the table, and every
// other material, builds exactly what it did. (WebGPU never calls onBeforeCompile: there the pass skins as three does.)
import * as THREE from 'three';

const PARS = `#include <skinning_pars_vertex>
#ifdef USE_SKINNING
	uniform highp sampler2D skinDQTexture;
	vec4 skinDQFetch( const in float bone, const in int k ) { return texelFetch( skinDQTexture, ivec2( int( bone ) * 5 + k, 0 ), 0 ); }
	vec3 skinDQTurn( const in vec4 q, const in vec3 v ) { return v + 2.0 * cross( q.xyz, cross( q.xyz, v ) + q.w * v ); }
#endif`;
// the blend, once a vertex: the scale rows linearly; the rigid parts each turned to the first one's hemisphere, summed, made unit
const BASE = `#ifdef USE_SKINNING
	vec4 skinDQR0 = skinDQFetch( skinIndex.x, 0 );
	vec4 skinDQR1 = skinDQFetch( skinIndex.y, 0 );
	vec4 skinDQR2 = skinDQFetch( skinIndex.z, 0 );
	vec4 skinDQR3 = skinDQFetch( skinIndex.w, 0 );
	float skinDQW1 = dot( skinDQR0, skinDQR1 ) < 0.0 ? - skinWeight.y : skinWeight.y;
	float skinDQW2 = dot( skinDQR0, skinDQR2 ) < 0.0 ? - skinWeight.z : skinWeight.z;
	float skinDQW3 = dot( skinDQR0, skinDQR3 ) < 0.0 ? - skinWeight.w : skinWeight.w;
	vec4 skinDQReal = skinDQR0 * skinWeight.x + skinDQR1 * skinDQW1 + skinDQR2 * skinDQW2 + skinDQR3 * skinDQW3;
	vec4 skinDQDual = skinDQFetch( skinIndex.x, 1 ) * skinWeight.x + skinDQFetch( skinIndex.y, 1 ) * skinDQW1 + skinDQFetch( skinIndex.z, 1 ) * skinDQW2 + skinDQFetch( skinIndex.w, 1 ) * skinDQW3;
	float skinDQLength = length( skinDQReal );
	skinDQReal /= skinDQLength;
	skinDQDual /= skinDQLength;
	vec4 skinDQRow0 = skinDQFetch( skinIndex.x, 2 ) * skinWeight.x + skinDQFetch( skinIndex.y, 2 ) * skinWeight.y + skinDQFetch( skinIndex.z, 2 ) * skinWeight.z + skinDQFetch( skinIndex.w, 2 ) * skinWeight.w;
	vec4 skinDQRow1 = skinDQFetch( skinIndex.x, 3 ) * skinWeight.x + skinDQFetch( skinIndex.y, 3 ) * skinWeight.y + skinDQFetch( skinIndex.z, 3 ) * skinWeight.z + skinDQFetch( skinIndex.w, 3 ) * skinWeight.w;
	vec4 skinDQRow2 = skinDQFetch( skinIndex.x, 4 ) * skinWeight.x + skinDQFetch( skinIndex.y, 4 ) * skinWeight.y + skinDQFetch( skinIndex.z, 4 ) * skinWeight.z + skinDQFetch( skinIndex.w, 4 ) * skinWeight.w;
#endif`;
// normals through the blended scale's cofactor (its inverse transpose, unnormalised), then turned; tangents through the scale itself
const NORMAL = `#ifdef USE_SKINNING
	vec3 skinDQC0 = vec3( skinDQRow0.x, skinDQRow1.x, skinDQRow2.x );
	vec3 skinDQC1 = vec3( skinDQRow0.y, skinDQRow1.y, skinDQRow2.y );
	vec3 skinDQC2 = vec3( skinDQRow0.z, skinDQRow1.z, skinDQRow2.z );
	objectNormal = skinDQTurn( skinDQReal, cross( skinDQC1, skinDQC2 ) * objectNormal.x + cross( skinDQC2, skinDQC0 ) * objectNormal.y + cross( skinDQC0, skinDQC1 ) * objectNormal.z );
	#ifdef USE_TANGENT
		objectTangent = skinDQTurn( skinDQReal, vec3( dot( skinDQRow0.xyz, objectTangent ), dot( skinDQRow1.xyz, objectTangent ), dot( skinDQRow2.xyz, objectTangent ) ) );
	#endif
#endif`;
const POSITION = `#ifdef USE_SKINNING
	vec3 skinDQScaled = vec3( dot( skinDQRow0, vec4( transformed, 1.0 ) ), dot( skinDQRow1, vec4( transformed, 1.0 ) ), dot( skinDQRow2, vec4( transformed, 1.0 ) ) );
	transformed = skinDQTurn( skinDQReal, skinDQScaled ) + 2.0 * ( skinDQDual.xyz * skinDQReal.w - skinDQReal.xyz * skinDQDual.w + cross( skinDQReal.xyz, skinDQDual.xyz ) );
#endif`;

/** The shader text with three's linear-blend skinning swapped for the blend above (each include must be there once). */
export function injectSkinDQ(vertexShader) {
  const swaps = [['#include <skinning_pars_vertex>', PARS], ['#include <skinbase_vertex>', BASE], ['#include <skinnormal_vertex>', NORMAL], ['#include <skinning_vertex>', POSITION]];
  let out = vertexShader;
  for (const [from, to] of swaps) if (out.includes(from)) out = out.replace(from, to);
  return out;
}

export const SKIN_DQ_PROGRAM_KEY = 'skin-dq-v1';

function dqMaterial(source, uniform) {
  const m = source.clone();
  // the clone is this mesh's own: a ground-AO mark copied from a shared material would keep the AO from composing with this (model3dLayer)
  delete m.userData.__groundAO;
  m.userData.skinDQ = true;
  m.onBeforeCompile = (shader) => {
    shader.uniforms.skinDQTexture = uniform;
    shader.vertexShader = injectSkinDQ(shader.vertexShader);
  };
  m.customProgramCacheKey = () => SKIN_DQ_PROGRAM_KEY;
  return m;
}

/**
 * Makes a dual-quaternion skinned mesh (world3d/rig/dualQuat.js useDualQuaternions) draw that way through WebGLRenderer. Returns what to
 * dispose with the instance ({ dispose }), or null for a mesh that blends linearly.
 */
export function useDualQuaternionsWebGL(sm) {
  const table = sm?.userData?.skinDualQuaternion;
  if (!table || sm.userData.skinDQWebGL) return null;
  sm.userData.skinDQUpdate?.();
  const texture = new THREE.DataTexture(table, table.length / 4, 1, THREE.RGBAFormat, THREE.FloatType);
  texture.needsUpdate = true;
  const uniform = { value: texture };
  const made = [];
  const own = (m) => { const c = dqMaterial(m, uniform); made.push(c); return c; };
  sm.material = Array.isArray(sm.material) ? sm.material.map(own) : own(sm.material);
  sm.customDepthMaterial = own(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }));
  sm.customDistanceMaterial = own(new THREE.MeshDistanceMaterial());
  // the table as the bones stand, before each draw and each shadow map (a frame's matrices are up to date by then)
  const refresh = () => { sm.userData.skinDQUpdate?.(); texture.needsUpdate = true; };
  const beforeRender = sm.onBeforeRender, beforeShadow = sm.onBeforeShadow;
  sm.onBeforeRender = function onBeforeRender(...args) { refresh(); return beforeRender.apply(this, args); };
  sm.onBeforeShadow = function onBeforeShadow(...args) { refresh(); return beforeShadow.apply(this, args); };
  sm.userData.skinDQWebGL = true;
  return { dispose() { texture.dispose(); for (const m of made) m.dispose(); } };
}
