import * as THREE from 'three';

// One near-floor geometry capture per rig, shared by every model. It belongs to
// the receiver pass: translucent model planes must never claim composite depth.
// The underside camera records the nearest surface, fading with height. Thus a
// slab, feet and a hollow frame retain their own silhouettes; elevated parts
// don't stamp a rectangle onto the floor or the model supporting them.
export function createRigContactShadows({ depthMaterial, blurMaterial } = {}) {
  const size = 1024;
  const target = () => new THREE.WebGLRenderTarget(size, size, {
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    depthBuffer: true, stencilBuffer: false,
  });
  const capture = target(), ping = target(), blurred = target();
  const camera = new THREE.OrthographicCamera();
  camera.layers.set(0);
  const depth = depthMaterial || new THREE.MeshDepthMaterial({ side: THREE.DoubleSide, depthPacking: THREE.BasicDepthPacking });
  depth.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      'gl_FragColor = vec4( vec3( 1.0 - fragCoordZ ), opacity );',
      'float coverage = pow( max( 0.0, 1.0 - fragCoordZ ), 2.0 ); gl_FragColor = vec4( vec3(coverage), 1.0 );'
    );
  };
  depth.customProgramCacheKey = () => 'rig-contact-height-v1';
  const blur = blurMaterial || new THREE.ShaderMaterial({
    uniforms: { source: { value: null }, stepUV: { value: new THREE.Vector2() } },
    depthTest: false, depthWrite: false, blending: THREE.NoBlending,
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: `varying vec2 vUv; uniform sampler2D source; uniform vec2 stepUV;
      void main() {
        vec4 value = vec4(0.0); float total = 0.0;
        for (int i = -8; i <= 8; i++) {
          float x = float(i); float w = exp(-0.5 * x * x / 9.0);
          value += texture2D(source, vUv + stepUV * x) * w; total += w;
        }
        gl_FragColor = value / total;
      }`,
  });
  const blurScene = new THREE.Scene();
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), blur);
  quad.frustumCulled = false;
  blurScene.add(quad);
  const material = new THREE.MeshBasicMaterial({
    alphaMap: blurred.texture, color: 0x000000, transparent: true,
    depthWrite: false, toneMapped: false, polygonOffset: true,
    polygonOffsetFactor: -1, polygonOffsetUnits: -1,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
  mesh.name = 'Rig contact shadow receiver';
  mesh.rotation.x = -Math.PI / 2;
  mesh.renderOrder = 10;
  mesh.visible = false;
  const box = new THREE.Box3(), inverse = new THREE.Matrix4();
  const center = new THREE.Vector3(), normal = new THREE.Vector3(), position = new THREE.Vector3();
  // What the last capture was taken from. The capture + two blurs cost about as
  // much as a model pass and are byte-identical while nothing near the floor
  // moves — a camera move, a light change or parts animating higher up included.
  let lastInputs = null, lastRenderer = null;
  const meshBox = new THREE.Box3();
  // The meshes that reach the capture (within its far plane above the floor): they
  // alone frame it and decide whether it must be taken again. Framing it on whole
  // models let parts animating high above the floor (an HVAC unit's flow streaks)
  // re-frame it every frame, and the blurred contact edge wobbled with the grid.
  const nearFloor = (roots, H) => {
    const inputs = [];
    let dynamic = false;
    box.makeEmpty();
    for (const root of roots) {
      root.traverseVisible((obj) => {
        if (!obj.isMesh || !obj.geometry) return;
        if (!obj.geometry.boundingBox) obj.geometry.computeBoundingBox();
        meshBox.copy(obj.geometry.boundingBox).applyMatrix4(obj.matrixWorld).applyMatrix4(inverse);
        if (meshBox.min.y > H * 0.12 || meshBox.max.y < 0) return;
        box.union(meshBox);
        // Bones and morphs move vertices without moving the matrix.
        if (obj.isSkinnedMesh || obj.morphTargetInfluences?.length) dynamic = true;
        inputs.push(obj.id, obj.geometry.id, ...obj.matrixWorld.elements);
      });
    }
    return dynamic ? null : inputs;
  };
  const sameInputs = (a, b) => !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);
  // The receiver: where, and how strongly, the capture lands on the floor.
  const place = (renderer, span, mode, opacity, color, layer) => {
    // Camera looks UP: image-up is +Z, opposite the floor plane's UV. WebGPU
    // already flips render-target alphaMap sampling; WebGL needs this flip.
    mesh.position.set(center.x, 0.025, center.z);
    mesh.scale.set(span, renderer.isWebGLRenderer ? -span : span, 1);
    material.side = THREE.DoubleSide;
    material.opacity = (mode === 'contact' ? 0.8 : 0.55) * opacity;
    material.color.set(color);
    mesh.layers.set(layer);
    mesh.visible = true;
  };

  return {
    mesh,
    /** Forget the last capture (its render targets did not survive, e.g. a context loss). */
    invalidate() { lastInputs = null; },
    update(renderer, scene, floor, roots, { H, mode, layer, opacity = 1, color = '#000000' }) {
      mesh.visible = false;
      if (!roots.length || (mode !== 'map' && mode !== 'contact') || opacity <= 0) return;
      floor.updateWorldMatrix(true, false);
      inverse.copy(floor.matrixWorld).invert();
      // Only nearby geometry can occlude the floor. A lifted model fades out in
      // the capture itself, independent of its origin or layer scale.
      const meshInputs = nearFloor(roots, H);
      if (box.isEmpty()) return;
      const pad = H * 0.04;
      // Size in steps of the pad, centre on whole capture texels: a part moving
      // near the floor changes what is captured, never the grid it lands on.
      const span = Math.ceil((Math.max(box.max.x - box.min.x, box.max.z - box.min.z, H * 0.1) + pad * 2) / pad) * pad;
      const floorScale = floor.getWorldScale(new THREE.Vector3()).x;
      const far = H * 0.12 * floorScale;
      box.getCenter(center);
      const texel = span / size;
      center.x = Math.round(center.x / texel) * texel;
      center.z = Math.round(center.z / texel) * texel;
      camera.left = -span * floorScale / 2; camera.right = span * floorScale / 2;
      camera.top = span * floorScale / 2; camera.bottom = -span * floorScale / 2;
      camera.near = 0.01; camera.far = far;
      position.set(center.x, -0.02, center.z).applyMatrix4(floor.matrixWorld);
      camera.position.copy(position);
      normal.set(0, 1, 0).transformDirection(floor.matrixWorld);
      camera.up.set(0, 0, 1).transformDirection(floor.matrixWorld);
      camera.lookAt(position.clone().add(normal));
      camera.updateProjectionMatrix(); camera.updateMatrixWorld(true);
      if (depth.uniforms) {
        depth.uniforms.contactNear.value = camera.near;
        depth.uniforms.contactFar.value = camera.far;
      }

      const inputs = meshInputs && [span, center.x, center.z, far, mode === 'contact' ? 1 : 0, H, ...floor.matrixWorld.elements, ...meshInputs];
      if (renderer === lastRenderer && sameInputs(inputs, lastInputs)) {
        place(renderer, span, mode, opacity, color, layer);
        return;
      }
      lastInputs = null;
      const saved = {
        target: renderer.getRenderTarget(), autoClear: renderer.autoClear,
        color: renderer.getClearColor(new THREE.Color()), alpha: renderer.getClearAlpha(),
        override: scene.overrideMaterial, background: scene.background,
        shadow: renderer.shadowMap.enabled,
      };
      const hidden = [];
      const capturedMeshes = new Set();
      for (const root of roots) root.traverseVisible((obj) => { if (obj.isMesh) capturedMeshes.add(obj); });
      // Hide receivers and light helpers; keep only actual casting meshes. The
      // visibility changes are restored even if a shader/render throws.
      scene.traverse((obj) => {
        if (obj.isMesh && obj.visible && (!capturedMeshes.has(obj) || obj === floor)) {
          hidden.push(obj); obj.visible = false;
        }
      });
      try {
        scene.overrideMaterial = depth; scene.background = null;
        renderer.shadowMap.enabled = false;
        renderer.autoClear = true;
        renderer.setClearColor(0x000000, 0);
        renderer.setRenderTarget(capture); renderer.render(scene, camera);
        scene.overrideMaterial = saved.override;
        blur.uniforms.source.value = capture.texture;
        // World-space softness stays identical when the capture bounds change.
        const sigma = H * (mode === 'contact' ? 0.009 : 0.005);
        blur.uniforms.stepUV.value.set(sigma / (3 * span), 0);
        renderer.setRenderTarget(ping); renderer.render(blurScene, camera);
        blur.uniforms.source.value = ping.texture;
        blur.uniforms.stepUV.value.set(0, sigma / (3 * span));
        renderer.setRenderTarget(blurred); renderer.render(blurScene, camera);
        lastInputs = inputs;
        lastRenderer = renderer;
      } finally {
        for (const obj of hidden) obj.visible = true;
        scene.overrideMaterial = saved.override; scene.background = saved.background;
        renderer.shadowMap.enabled = saved.shadow;
        renderer.setRenderTarget(saved.target); renderer.autoClear = saved.autoClear;
        renderer.setClearColor(saved.color, saved.alpha);
      }
      place(renderer, span, mode, opacity, color, layer);
    },
    dispose() {
      mesh.removeFromParent(); mesh.geometry.dispose(); material.dispose();
      quad.geometry.dispose(); blur.dispose(); depth.dispose();
      capture.dispose(); ping.dispose(); blurred.dispose();
    },
  };
}
