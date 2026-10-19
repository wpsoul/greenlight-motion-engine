/*
 * The flat shadow plate's material, as GLSL.
 *
 * Extracted from model3dLayer.js so the port harness can import it. That module
 * pulls GLTFLoader and the whole rig/plate stack, which a lab page cannot
 * resolve — and the alternative, copying the shader in, is exactly the drift
 * this port has been avoiding. Third time this pattern has been needed
 * (cameraDof.js, model3dTonePass.js), so it is the rule now, not an exception:
 * if a material has to be A/B'd, it lives somewhere importable.
 *
 * Nothing about the material changed.
 */
import * as THREE from 'three';

export function makeShadowPlateMaterial() {
  const material = new THREE.ShadowMaterial({
    transparent: true,
    opacity: 0.7,
    side: THREE.DoubleSide,
    alphaTest: 0.02,
    depthWrite: true,
    toneMapped: false,
  });
  // WebGLShadowMap copies `map` and `alphaTest` into its depth material. ShadowMaterial
  // does not declare a map of its own, but the property is intentionally present so
  // transparent pixels never cast a rectangular shadow.
  material.map = null;
  material.userData.receiveShadow = false;
  // ONE uniform object per material, handed to every program compiled from it. A
  // plate draws in the shared world and — while the 3D view is open — in the scene
  // that view borrows it into; that is two program variants, and caching only the
  // last compiled shader's uniforms left whichever one drew second sampling a
  // texture nobody was updating.
  material.userData.plateUniforms = {
    uPlate: { value: null },
    uReceiveShadow: { value: 0 },
  };
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uPlate = material.userData.plateUniforms.uPlate;
    shader.uniforms.uReceiveShadow = material.userData.plateUniforms.uReceiveShadow;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vPlateUv;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPlateUv = uv;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D uPlate;\nuniform float uReceiveShadow;\nvarying vec2 vPlateUv;')
      .replace(
        'gl_FragColor = vec4( color, opacity * ( 1.0 - getShadowMask() ) );',
        `vec4 plate = texture2D( uPlate, vPlateUv );
        if ( plate.a < 0.02 ) discard;
        float received = uReceiveShadow * ( 1.0 - getShadowMask() );
        vec3 straightRgb = plate.a > 0.0001 ? plate.rgb / plate.a : vec3( 0.0 );
        gl_FragColor = vec4( straightRgb * ( 1.0 - opacity * received ), plate.a );`
      );
  };
  material.customProgramCacheKey = () => 'flat-shadow-plate-v1';
  return material;
}
