/*
 * TSL twin of stripEffect.js — the GLSL is the reference; keep the two in lockstep.
 * All box-pixel maths on fxLocal, which is y-up on both backends in both scopes
 * (runEffectChain's WebGPU axis flip), so it ports verbatim. Slot 24 = reach, written
 * per frame on the CPU (STRIP_EFFECT.frameUniforms).
 */
import { vec2, vec3, vec4, float, clamp, max, min } from 'three/tsl';

export const STRIP_BODIES = {
  strip: ({ u, uvn, srcCol, helpers }) => {
    const P = u.uParams;
    const res = helpers.fxRes();
    const px = helpers.fxLocal(uvn).mul(res);
    const hPx = clamp(P.element(0).div(100.0), 0.0, 0.5).mul(max(P.element(24), 0.0)).mul(res.y);
    const bottom = clamp(hPx.sub(px.y).add(0.5), 0.0, 1.0);
    const top = clamp(hPx.sub(res.y.sub(px.y)).add(0.5), 0.0, 1.0);
    const inside = clamp(min(px, res.sub(px)).add(0.5), vec2(0.0), vec2(1.0));
    const cov = max(top, bottom).mul(inside.x).mul(inside.y);
    return srcCol.mul(float(1.0).sub(cov)).add(vec4(vec3(u.uColor), 1.0).mul(cov));
  },
};
