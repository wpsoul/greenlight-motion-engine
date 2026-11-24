/*
 * WebGPU TSL twin of depthKeyLayer.js's AE Depth Matte pass.
 *
 *   createDepthKeyNodeMaterial() <- createDepthKeyMaterial()
 *
 * CRITICAL INVARIANT (depthScanNodes.js):
 * Reads fragment coordinates via `screenCoordinate.xy.div(u.uResolution)` +
 * `u.uFxHomInv` — NEVER `uv()`, NO V-flip — paired with the two-hop
 * `flipPlate` normalizer blit in engine/layerPasses.js so WebGPU and WebGL
 * produce identical upright orientation and identical uniform `.value` drive.
 */
import * as THREE from 'three/webgpu';
import {
  Fn, If, uniform, screenCoordinate, vec2, vec3, vec4, float,
  dot, mix, clamp, abs, max, min, exp, pow, smoothstep, select,
} from 'three/tsl';
import { makeTslSampler } from './tslSampler.js';

export function createDepthKeyNodeMaterial() {
  const u = {
    uTexture: makeTslSampler({ rgba: [0, 0, 0, 0] }),
    uDepth: makeTslSampler({ rgba: [0, 0, 0, 1] }),
    uResolution: uniform(new THREE.Vector2(1280, 720)),
    uDepthSize: uniform(new THREE.Vector2(384, 216)),
    uFxOrigin: uniform(new THREE.Vector2(0.5, 0.5)),
    uFxAxisX: uniform(new THREE.Vector2(0.5, 0)),
    uFxAxisY: uniform(new THREE.Vector2(0, 0.5)),
    uFxHom: uniform(new THREE.Matrix3()),
    uFxHomInv: uniform(new THREE.Matrix3()),
    uInvert: uniform(0),
    uMode: uniform(0),
    uDepthCut: uniform(0.5),
    uFeather: uniform(0.06),
    uBandWidth: uniform(0.18),
    uGamma: uniform(1.0),
    uEdgeSnap: uniform(0.35),
    uChoke: uniform(0),
    uKeyInvert: uniform(0),
    uMix: uniform(1.0),
    uView: uniform(0),
  };

  const fxLocal = (uvn) => {
    const h = u.uFxHomInv.mul(vec3(uvn.x, uvn.y, 1.0)).toVar();
    const l = h.xy.div(max(h.z, 1e-6));
    return select(h.z.lessThan(1e-6), vec2(-1e3, -1e3), l);
  };

  const readDepthRaw = (p) => {
    const raw = u.uDepth.sample(clamp(p, 0.0, 1.0)).r;
    const d = select(u.uInvert.greaterThan(0.5), raw.oneMinus(), raw);
    return pow(clamp(d, 0.0, 1.0), max(u.uGamma, 0.05));
  };

  const evalMatte = (d) => {
    const hw = max(float(0.001), u.uFeather.mul(0.5));
    const ramp = smoothstep(u.uDepthCut.sub(hw), u.uDepthCut.add(hw), d);
    const fg = ramp;
    const bg = ramp.oneMinus();
    const bwHalf = max(float(0.005), u.uBandWidth.mul(0.5));
    const band = smoothstep(bwHalf.sub(hw), bwHalf.add(hw), abs(d.sub(u.uDepthCut))).oneMinus();
    const rawM = select(u.uMode.lessThan(0.5), fg, select(u.uMode.lessThan(1.5), bg, band));
    const invM = select(u.uKeyInvert.greaterThan(0.5), rawM.oneMinus(), rawM);
    return clamp(invM, 0.0, 1.0);
  };

  const CHOKE_DIRS = [
    [1.0, 0.0],
    [-1.0, 0.0],
    [0.0, 1.0],
    [0.0, -1.0],
    [0.7071, 0.7071],
    [-0.7071, 0.7071],
    [0.7071, -0.7071],
    [-0.7071, -0.7071],
  ];

  const material = new THREE.MeshBasicNodeMaterial();
  material.fragmentNode = Fn(() => {
    const safeRes = max(vec2(1.0, 1.0), u.uResolution);
    const uvn = screenCoordinate.xy.div(safeRes);
    const s = u.uTexture.sample(uvn);
    const cov = s.a.toVar();
    const src = select(cov.greaterThan(1e-5), s.rgb.div(max(cov, 1e-5)), vec3(0.0)).toVar();

    const p = fxLocal(uvn).toVar();
    const d = readDepthRaw(p).toVar();

    If(u.uEdgeSnap.greaterThan(0.001), () => {
      const stepUv = vec2(1.5, 1.5).div(safeRes);
      const sumW = float(0.0).toVar();
      const sumD = float(0.0).toVar();
      for (let oy = -1; oy <= 1; oy += 1) {
        for (let ox = -1; ox <= 1; ox += 1) {
          const nUvn = clamp(uvn.add(vec2(ox, oy).mul(stepUv)), 0.0, 1.0);
          const nCol = u.uTexture.sample(nUvn);
          const nRgb = select(nCol.a.greaterThan(1e-4), nCol.rgb.div(max(nCol.a, 1e-4)), src);
          const dc = nRgb.sub(src);
          const wc = exp(dot(dc, dc).div(-0.018));
          const wsVal = (ox === 0 && oy === 0) ? 1.0 : ((Math.abs(ox) + Math.abs(oy) === 1) ? 0.7 : 0.45);
          const w = wc.mul(wsVal);
          sumW.addAssign(w);
          sumD.addAssign(w.mul(readDepthRaw(fxLocal(nUvn))));
        }
      }
      const snapped = sumD.div(max(sumW, 1e-5));
      d.assign(mix(d, snapped, clamp(u.uEdgeSnap, 0.0, 1.0)));
    });

    const m = evalMatte(d).toVar();

    If(abs(u.uChoke).greaterThan(0.01), () => {
      const rad = vec2(abs(u.uChoke), abs(u.uChoke)).div(safeRes);
      const ext = m.toVar();
      const shrink = u.uChoke.greaterThan(0.0);
      for (const [dx, dy] of CHOKE_DIRS) {
        const tapUv = clamp(uvn.add(vec2(dx, dy).mul(rad)), 0.0, 1.0);
        const mn = evalMatte(readDepthRaw(fxLocal(tapUv)));
        ext.assign(select(shrink, min(ext, mn), max(ext, mn)));
      }
      m.assign(mix(m, ext, clamp(abs(u.uChoke), 0.0, 1.0)));
    });

    const keep = mix(float(1.0), m, clamp(u.uMix, 0.0, 1.0)).toVar();
    const zeroOut = cov.lessThanEqual(1e-5);

    const outA = clamp(cov.mul(keep), 0.0, 1.0);
    const finalCol = vec4(clamp(src.mul(outA), 0.0, 1.0), outA);
    const matteCol = vec4(vec3(keep).mul(cov), cov);

    const cutTol = max(float(0.008), u.uFeather.mul(0.15));
    const line = smoothstep(float(0.0), cutTol, abs(d.sub(u.uDepthCut))).oneMinus();
    const cutCol = vec4(mix(vec3(d), vec3(1.0, 0.2, 0.8), line).mul(cov), cov);

    const keptTint = mix(src, vec3(0.32, 0.95, 0.48), 0.25);
    const cutTint = mix(src.mul(0.45), vec3(0.85, 0.2, 0.25), 0.45);
    const zoneCol = vec4(mix(cutTint, keptTint, keep).mul(cov), cov);

    const picked = select(
      u.uView.greaterThan(2.5),
      zoneCol,
      select(
        u.uView.greaterThan(1.5),
        cutCol,
        select(u.uView.greaterThan(0.5), matteCol, finalCol),
      ),
    );
    return select(zeroOut, vec4(0.0), picked);
  })();

  material.transparent = true;
  material.blending = THREE.NoBlending;
  material.depthTest = false;
  material.depthWrite = false;
  material.forceSinglePass = true;
  material.uniforms = u;
  return material;
}
