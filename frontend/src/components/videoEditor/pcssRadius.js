/** Pack the per-light PCSS parameters into `shadow.radius`: the WebGL filter in rigSoftShadows.js and its WebGPU twin in model3dNodes.js read it back. */
export function encodePcssRadius(capTexels, kTexelsPerDepth) {
  const capq = Math.max(0, Math.min(1023, Math.round((Number.isFinite(capTexels) ? capTexels : 4) * 4)));
  const kq = Math.max(0, Math.min(8191, Math.round(Math.log2(1 + Math.max(0, Number.isFinite(kTexelsPerDepth) ? kTexelsPerDepth : 0)) * 256)));
  return kq * 1024 + capq;
}
