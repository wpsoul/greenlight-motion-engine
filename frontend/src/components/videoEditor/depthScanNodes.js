/*
 * TSL twin of depthScanLayer.js's single pass.
 *
 *   createDepthScanNodeMaterial() ← createDepthScanMaterial()
 *
 * Same uniform surface (`.uniforms.<name>.value`), so applyDepthScanUniforms
 * drives either. Three structural differences from the GLSL, all of them the
 * port's standing conventions:
 *
 *   `screenCoordinate.xy / uResolution` replaces gl_FragCoord / uResolution —
 *   NOT `uv()`, which is what most passes here use. This one draws a fullscreen
 *   quad and then measures the LAYER BOX against the frame, and `uv()` is the
 *   geometry attribute: on WebGPU it runs opposite to the render target's own V
 *   axis, so the whole output came back vertically MIRRORED while WebGL was
 *   perfect. `screenCoordinate` is the fragment's real position on both
 *   backends, which is why Auto Fill's twin — the pass this one is modelled on,
 *   and the only other one that maps a box into a full-frame plate — uses it
 *   too. Measured, with Auto Fill and Running Glow as upright controls:
 *   tests/depth-scan/probe_control.js.
 *
 *   NO flip flag, on either side. The caller normalises a camera-rendered
 *   isolate with the Auto Fill blit before this pass ever sees it, so the plate
 *   read, the box and the depth read all sit on the frame's own uv. That also
 *   fixes the hop count at TWO on both backends, which is what keeps WebGPU
 *   upright — one hop came out vertically mirrored (measured; see
 *   tests/depth-scan/verify_render.js).
 *
 *   The three view modes are `select()` rather than early returns, and the
 *   colour modes are If/ElseIf writing one var — TSL has no `return` mid-graph.
 */
import * as THREE from 'three/webgpu';
import {
  Fn, If, uniform, screenCoordinate, vec2, vec3, vec4, float,
  dot, mix, clamp, abs, max, min, sin, floor, fract, pow, smoothstep, select, fwidth,
} from 'three/tsl';
import { makeTslSampler } from './tslSampler.js';

export function createDepthScanNodeMaterial() {
  const u = {
    uTexture: makeTslSampler({ rgba: [0, 0, 0, 0] }),
    uDepth: makeTslSampler({ rgba: [0, 0, 0, 1] }),
    uRamp: makeTslSampler({ rgba: [1, 1, 1, 1] }),
    uResolution: uniform(new THREE.Vector2(1280, 720)),
    uDepthSize: uniform(new THREE.Vector2(384, 216)),
    uFxOrigin: uniform(new THREE.Vector2(0.5, 0.5)),
    uFxAxisX: uniform(new THREE.Vector2(0.5, 0)),
    uFxAxisY: uniform(new THREE.Vector2(0, 0.5)),
    uFxHom: uniform(new THREE.Matrix3()),
    uFxHomInv: uniform(new THREE.Matrix3()),
    uPhase: uniform(0),
    uWidth: uniform(0.011),
    uSplit: uniform(0.024),
    uFeather: uniform(0.0035),
    uGrain: uniform(0.22),
    uPixel: uniform(1),
    uGamma: uniform(1),
    uLow: uniform(0.015),
    uHigh: uniform(0.995),
    uBorder: uniform(1),
    uInvert: uniform(0),
    uColorMode: uniform(0),
    uColor: uniform(new THREE.Vector3(0.72, 1, 0.32)),
    uBrightness: uniform(1.25),
    uSourceMix: uniform(0),
    uAmount: uniform(1),
    uView: uniform(0),
  };

  const scnHash = (p) => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453123));

  // Through the layer plane's projective map, like the GLSL (the affine frame
  // cannot describe the trapezoid a 3D tilt projects).
  const fxLocal = (uvn) => {
    const h = u.uFxHomInv.mul(vec3(uvn.x, uvn.y, 1.0)).toVar();
    const l = h.xy.div(max(h.z, 1e-6));
    return select(h.z.lessThan(1e-6), vec2(-1e3, -1e3), l);
  };

  const readDepth = (p) => {
    const cells = max(vec2(1.0, 1.0), u.uDepthSize.div(max(u.uPixel, 1.0)));
    const q = floor(p.mul(cells)).add(0.5).div(cells);
    const raw = u.uDepth.sample(clamp(q, 0.0, 1.0)).r;
    const d = select(u.uInvert.greaterThan(0.5), raw.oneMinus(), raw);
    return pow(clamp(d, 0.0, 1.0), u.uGamma);
  };

  const material = new THREE.MeshBasicNodeMaterial();
  material.fragmentNode = Fn(() => {
    const uvn = screenCoordinate.xy.div(u.uResolution);
    const s = u.uTexture.sample(uvn);
    const cov = s.a.toVar();
    const src = select(cov.greaterThan(1e-4), s.rgb.div(max(cov, 1e-4)), vec3(0.0)).toVar();

    const p = fxLocal(uvn).toVar();
    const d = readDepth(p).toVar();

    // The same integer pixel grid the GLSL twin hashes, so the speckle lands on
    // the same cells on both backends.
    const n = scnHash(floor(screenCoordinate.xy.div(max(u.uPixel, 1.0)))).sub(0.5)
      .mul(u.uGrain).mul(u.uWidth.add(u.uFeather)).mul(1.6).toVar();

    const soft = max(u.uFeather, fwidth(d).mul(0.35)).toVar();
    const band = (center, noise, w) => float(1.0).sub(smoothstep(w, w.add(soft), abs(d.sub(center).add(noise))));

    const scan = vec3(0.0).toVar();
    If(u.uColorMode.lessThan(0.5), () => {
      scan.assign(vec3(
        band(clamp(u.uPhase.sub(u.uSplit), 0.0, 1.0), n, u.uWidth),
        band(u.uPhase, n.mul(0.35), u.uWidth),
        band(clamp(u.uPhase.add(u.uSplit), 0.0, 1.0), n.negate(), u.uWidth),
      ));
    }).ElseIf(u.uColorMode.lessThan(1.5), () => {
      scan.assign(u.uColor.mul(band(u.uPhase, n.mul(0.35), u.uWidth)));
    }).Else(() => {
      const ext = max(u.uSplit, u.uWidth);
      const m = band(u.uPhase, n.mul(0.35), u.uWidth.add(u.uSplit));
      const t = clamp(d.sub(u.uPhase).add(n.mul(0.35)).div(ext.mul(2.0)).add(0.5), 0.0, 1.0);
      scan.assign(u.uRamp.sample(vec2(t, 0.5)).rgb.mul(m));
    });

    const valid = smoothstep(u.uLow, u.uLow.add(0.012), d)
      .mul(smoothstep(u.uHigh.sub(0.012), u.uHigh, d).oneMinus());
    const texel = max(vec2(2.0, 2.0), vec2(u.uPixel.mul(2.0), u.uPixel.mul(2.0))).div(u.uDepthSize);
    const jump = max(
      max(abs(d.sub(readDepth(p.add(vec2(texel.x, 0.0))))), abs(d.sub(readDepth(p.sub(vec2(texel.x, 0.0)))))),
      max(abs(d.sub(readDepth(p.add(vec2(0.0, texel.y))))), abs(d.sub(readDepth(p.sub(vec2(0.0, texel.y)))))),
    );
    const interior = smoothstep(0.018, 0.09, jump).oneMinus();
    const borderMask = mix(float(1.0), interior, u.uBorder);

    const lit = scan.mul(valid).mul(borderMask).mul(u.uBrightness);
    const effected = src.mul(u.uSourceMix).add(lit);
    const result = clamp(mix(src, effected, u.uAmount), 0.0, 1.0);

    return select(
      u.uView.greaterThan(1.5),
      vec4(src.mul(cov), cov),
      select(
        u.uView.greaterThan(0.5),
        vec4(vec3(d).mul(cov), cov),
        vec4(min(result.mul(cov), vec3(cov)), cov),
      ),
    );
  })();

  material.transparent = true;
  material.blending = THREE.NoBlending;
  material.depthTest = false;
  material.depthWrite = false;
  // ShaderMaterial defaults this to true, every NodeMaterial to false (PORTING-GUIDE §13).
  material.forceSinglePass = true;
  material.uniforms = u;
  return material;
}
