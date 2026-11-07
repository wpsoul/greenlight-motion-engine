// Chrome 153's shader compiler dies on a swizzle of a swizzle ("swizzle view instruction still has usages after lowering"), and three writes
// `v.xy.x` for every lit material, so the whole world came up invalid in a plain Chrome. `v.xy.x` is `v.x`: the text is put right before any
// device compiles it. Importing this once covers every renderer on the page.
const POSITIONS = 'xyzw';
if (typeof GPUDevice !== 'undefined' && !GPUDevice.prototype.createShaderModule.swizzleFixed) {
  const original = GPUDevice.prototype.createShaderModule;
  const fixed = function createShaderModule(descriptor) {
    const code = descriptor.code.replace(/\.([xyzw]{2,4})\.([xyzw])\b/g, (_, inner, outer) => `.${inner[POSITIONS.indexOf(outer)]}`);
    return original.call(this, { ...descriptor, code });
  };
  fixed.swizzleFixed = true;
  GPUDevice.prototype.createShaderModule = fixed;
}
