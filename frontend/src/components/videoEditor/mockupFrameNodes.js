/*
 * TSL twin of mockupFrame.js's MF_FRAGMENT — matrix row 17.
 *
 * Ported from the verdicted pair 17 (37 states, max Δ ≤ 2, zero pixels > 2/255).
 * The body is that lab's; the uniform surface is rebuilt as a facade so
 * applyMockupFrameUniforms writes into it exactly as it writes the
 * ShaderMaterial's uniforms.
 *
 * Two things here are load-bearing and easy to "clean up" into bugs:
 *
 *   The two chassis reads are HOISTED out of the in-field `if` the GLSL guards
 *   them with, and masked instead. WGSL forbids implicit-LOD texture sampling
 *   under non-uniform control flow; the out-of-field result is discarded either
 *   way (ClampToEdge, mask 0), so it is the same arithmetic — but writing it as
 *   a branch does not compile.
 *
 *   `uScreenR > 0.0` IS a real branch, not a perf guard. At radius 0 the corner
 *   SDF would kill the whole screen rect, so the guard is semantic (§8).
 */
import * as THREE from 'three/webgpu';
import {
  uniform, texture, attribute, varying, vec2, vec3, vec4, float, clamp, abs, max, min,
  length, smoothstep, select, Fn, Discard, mix, fract,
} from 'three/tsl';
import { makeTslSampler } from './tslSampler.js';

/** Null-safe binding facade — see tslSampler.js for why null must never
 * reach TextureNode.value, and why the fallback is created once. */
const makeSampler = () => makeTslSampler({ rgba: [0, 0, 0, 0] });

// MF_COMMON: box uv (y DOWN) → frame uv (y UP) through the layer's HOMOGRAPHY
// (the plane's own projective map, so a 3D tilt keystones the chassis exactly
// like the artwork). The matrix is passed in EXPLICITLY so the emitted WGSL
// function closes over its arguments only — a laid-out Fn that captures a
// uniform emits a stale uniform index (§2/§7b).
const boxToFrame = Fn(([b, hom]) => {
  const h = hom.mul(vec3(b.x, b.y, 1.0)).toVar();
  return h.xy.div(h.z);
}).setLayout({
  name: 'mfBoxToFrame',
  type: 'vec2',
  inputs: [{ name: 'b', type: 'vec2' }, { name: 'hom', type: 'mat3' }],
});

/*
 * Frame uv → clip space with Y NEGATED. Same as warpNodes / repetile: this pass
 * writes clip by hand from `aRest`, which bypasses Three's WebGPU
 * framebuffer-origin compensation. Without the negate the whole chassis is a
 * vertical mirror. The quad is a FRAME-uv rectangle (uQuad) and the fragment
 * inverts the homography itself, so no quad corner can ever cross the camera
 * plane. The isolate sample flips by PLATE PROVENANCE (uFlipV): a
 * camera-rendered isolate is stored on the opposite V axis under WebGPU and
 * needs the flip; a quad-written plate does not. Chassis canvas atlases still
 * flip V below (upload orientation).
 */
const clipFromFrame = (f) => vec4(
  f.x.mul(2.0).sub(1.0),
  float(1.0).sub(f.y.mul(2.0)),
  0.0,
  1.0,
);

/** Mirrors createMockupFramePass()'s material uniform surface key for key. */
export function createMockupFrameNodeMaterial() {
  const u = {
    uTexture: makeSampler(),
    // 1 while uTexture is the camera-rendered isolate straight from the channel
    // camera; 0 for quad-written plates. Set per draw from plate provenance.
    uFlipV: uniform(0),
    uChassis: makeSampler(),
    uFront: makeSampler(),
    uHom: uniform(new THREE.Matrix3()),
    uHomInv: uniform(new THREE.Matrix3()),
    uQuad: uniform(new THREE.Vector4(0, 0, 1, 1)),
    uBoxPx: uniform(new THREE.Vector2(1920, 1080)),
    uDevSize: uniform(new THREE.Vector2(1, 1)),
    uTexSize: uniform(new THREE.Vector2(1, 1)),
    uPad: uniform(0),
    uCenter: uniform(new THREE.Vector2(0, 0)),
    uRot: uniform(new THREE.Vector2(1, 0)),
    uInvScale: uniform(1),
    uScreen: uniform(new THREE.Vector4(0, 0, 1, 1)),
    uMediaC: uniform(new THREE.Vector2(0, 0)),
    uMediaRot: uniform(new THREE.Vector2(1, 0)),
    uMediaInv: uniform(new THREE.Vector2(1, 1)),
    uMediaWrap: uniform(0),
    uScreenR: uniform(0),
    uSeated: uniform(0),
    uScreenBg: uniform(new THREE.Color('#0b0d12')),
  };
  // The lab's names, aliased so its body below stays verbatim.
  const { uHom, uHomInv, uQuad, uBoxPx, uDevSize, uTexSize, uPad, uCenter,
    uRot, uInvScale, uScreen, uMediaC, uMediaRot, uMediaInv, uMediaWrap, uScreenR, uSeated, uScreenBg } = u;
  const texIso = u.uTexture;
  const texUnder = u.uChassis;
  const texFront = u.uFront;

  const aRest = attribute('aRest', 'vec2');
  const vFrame = varying(mix(uQuad.xy, uQuad.zw, aRest));

  const material = new THREE.MeshBasicNodeMaterial();
  material.vertexNode = clipFromFrame(vFrame);

  material.fragmentNode = Fn(() => {
    // frame uv → box uv through the inverse homography. A point past the camera
    // plane (w <= 0) has no box position: it is masked to nothing and discarded at
    // the end with everything else, so no texture read sits under a branch.
    const bh = uHomInv.mul(vec3(vFrame.x, vFrame.y, 1.0)).toVar();
    const behind = bh.z.lessThanEqual(1e-6);
    const vRest = bh.xy.div(max(bh.z, 1e-6)).toVar();
    // box uv → chassis-local device units (inverse translate/rotate/scale)
    const q = vRest.mul(uBoxPx).sub(uCenter).toVar();
    const r = vec2(
      q.x.mul(uRot.x).add(q.y.mul(uRot.y)),
      q.x.mul(uRot.y).negate().add(q.y.mul(uRot.x)),
    ).toVar();
    const d = r.mul(uInvScale).add(uDevSize.mul(0.5)).toVar();

    const dUV = d.add(vec2(uPad, uPad)).div(uTexSize).toVar();
    // The GLSL guards the two chassis reads with an in-field `if`. Here the
    // samples are HOISTED out of the branch and masked instead: WGSL forbids
    // implicit-LOD texture sampling under non-uniform control flow, and the
    // out-of-field result is discarded either way (ClampToEdge, mask 0), so it
    // is exactly the same arithmetic.
    const cuv = vec2(dUV.x, float(1.0).sub(dUV.y));
    const rawUnder = texUnder.sample(cuv).toVar();
    const rawFront = texFront.sample(cuv).toVar();
    const inField = dUV.x.greaterThanEqual(0.0).and(dUV.x.lessThanEqual(1.0))
      .and(dUV.y.greaterThanEqual(0.0)).and(dUV.y.lessThanEqual(1.0));
    // A canvas upload arrives with STRAIGHT alpha, so it is premultiplied here.
    const under = select(inField, vec4(rawUnder.rgb.mul(rawUnder.a), rawUnder.a), vec4(0.0)).toVar();
    const front = select(inField, vec4(rawFront.rgb.mul(rawFront.a), rawFront.a), vec4(0.0)).toVar();

    // The display's exact rounded/continuous shape is the COMPLEMENTARY alpha
    // the device's own Canvas2D screenPath punched into the underlay.
    const rel = d.sub(uScreen.xy).toVar();
    const inRect = rel.x.greaterThanEqual(0.0).and(rel.y.greaterThanEqual(0.0))
      .and(rel.x.lessThanEqual(uScreen.z)).and(rel.y.lessThanEqual(uScreen.w));
    const inScreen = select(inRect, clamp(float(1.0).sub(under.a), 0.0, 1.0), float(0.0)).toVar();
    // Artwork chassis are transparent past their own silhouette, so those need
    // the analytic corner too. `uScreenR > 0.0` is a real branch, not a perf
    // guard: at 0 the SDF would kill the whole screen rect.
    const hc = uScreen.zw.mul(0.5).toVar();
    const pq = abs(rel.sub(hc)).sub(hc).add(vec2(uScreenR, uScreenR)).toVar();
    const sd = length(max(pq, vec2(0.0))).sub(uScreenR).toVar();
    const fe = max(uInvScale, 1e-4).toVar();
    const corner = float(1.0).sub(smoothstep(fe.mul(0.5), fe.mul(1.5), sd));
    inScreen.assign(select(uScreenR.greaterThan(0.0), inScreen.mul(corner), inScreen));

    const m = d.sub(uMediaC).toVar();
    const mr = vec2(
      m.x.mul(uMediaRot.x).add(m.y.mul(uMediaRot.y)),
      m.x.mul(uMediaRot.y).negate().add(m.y.mul(uMediaRot.x)),
    ).toVar();
    const muv = mr.mul(uMediaInv).add(0.5).toVar();
    muv.assign(select(uMediaWrap.greaterThan(0.5), fract(muv), muv));
    // Seated isolate: the artwork is already under this fragment; otherwise read it
    // from where the box projects.
    const isoUv = select(uSeated.greaterThan(0.5), vFrame, boxToFrame(muv, uHom)).toVar();
    const src = texIso.sample(vec2(isoUv.x, mix(isoUv.y, isoUv.y.oneMinus(), u.uFlipV))).toVar();
    const bg = vec4(uScreenBg, 1.0).toVar();
    const inUv = muv.x.greaterThanEqual(0.0).and(muv.x.lessThanEqual(1.0))
      .and(muv.y.greaterThanEqual(0.0)).and(muv.y.lessThanEqual(1.0));
    // backdrop wherever the artwork does not reach (contain, or scaled down)
    const mediaIn = select(inUv, src.add(bg.mul(float(1.0).sub(src.a))), bg);
    const media = select(inScreen.greaterThan(0.0), mediaIn.mul(inScreen), vec4(0.0)).toVar();

    // punched body + clipped media (complementary coverages), then the separate
    // front glass/island texture source-over both.
    const bodyAndMedia = under.add(media);
    const out = front.add(bodyAndMedia.mul(float(1.0).sub(front.a))).toVar();
    out.assign(select(behind, vec4(0.0), out));
    Discard(out.a.lessThanEqual(0.0));
    return out;
  })();

  material.transparent = true;
  material.transparent = true;
  material.depthTest = false;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  material.blending = THREE.CustomBlending;      // the isolate is premultiplied
  material.blendSrc = THREE.OneFactor;
  material.blendDst = THREE.OneMinusSrcAlphaFactor;
  // ShaderMaterial forces forceSinglePass = true; node materials inherit false,
  // which would give this transparent DoubleSide quad the renderer's
  // back-then-front two-pass split and composite it TWICE (§13).
  material.forceSinglePass = true;
  material.uniforms = u;
  return material;
}
