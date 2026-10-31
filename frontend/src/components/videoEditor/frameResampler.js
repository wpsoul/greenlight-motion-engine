/**
 * A filtered downscale of a rendered frame, for a scaled render whose buffer is
 * neither the output size nor twice it.
 *
 * A downscaled render draws at the composition size and the 2D canvas resamples it
 * to the output. Measured in headless Chromium, every 2D path (drawImage at any
 * imageSmoothingQuality, createImageBitmap's resizeQuality) is plain bilinear with
 * no prefilter: exact at 2:1 (a 4K project at 1080p, where it is a box filter), but
 * at 2648 → 1920 it skips texels and a 1 px grid beats into uneven lines. Under a
 * camera zoom the buffer shrinks with the zoom (resolveScaledRenderSize), so a 1.45×
 * Smart Zoom lands on exactly such a ratio; this resamples it instead.
 *
 * Separable Lanczos-3 (ffmpeg's lanczos scaler, the plan's reference), its support
 * widened by the scale, on the GPU: one upload of the frame, a horizontal and a
 * vertical pass. One WebGL2 context for the page, created the first time a frame
 * needs it, and shrunk to nothing between uses (releaseFrameResampler) rather than
 * lost — losing a context reads as a GPU reset (gpuReset.js), and leaving one per
 * use to the GC would let Chrome's context cap evict the renderer's own.
 */

const VERT = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

// One pass along uDir. The source is premultiplied, so colour can be filtered
// linearly; the negative lobes are clamped back into [0, alpha] at the end.
const FRAG = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uDir;
uniform float uScale;
uniform int uLast;
out vec4 outColor;
const float PI = 3.14159265358979;
float lanczos3(float x) {
  x = abs(x);
  if (x < 1e-5) return 1.0;
  if (x >= 3.0) return 0.0;
  float px = PI * x;
  return 3.0 * sin(px) * sin(px / 3.0) / (px * px);
}
void main() {
  ivec2 size = textureSize(uSrc, 0);
  int n = int(dot(vec2(size), uDir));
  float at = dot(gl_FragCoord.xy, uDir) * uScale;
  int across = int(dot(gl_FragCoord.xy, vec2(1.0) - uDir));
  float stretch = max(uScale, 1.0);
  int first = int(floor(at - 3.0 * stretch));
  vec4 sum = vec4(0.0);
  float wsum = 0.0;
  for (int k = 0; k < 64; k++) {
    int i = first + k;
    float d = (float(i) + 0.5 - at) / stretch;
    if (d > 3.0) break;
    float w = lanczos3(d);
    int t = clamp(i, 0, n - 1);
    ivec2 p = uDir.x > 0.5 ? ivec2(t, across) : ivec2(across, t);
    sum += w * texelFetch(uSrc, p, 0);
    wsum += w;
  }
  vec4 c = sum / wsum;
  if (uLast == 1) {
    c.a = clamp(c.a, 0.0, 1.0);
    c.rgb = clamp(c.rgb, vec3(0.0), vec3(c.a));
  }
  outColor = c;
}`;

let state = null;

function init() {
  if (state && !state.gl.isContextLost()) return state;
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  // preserveDrawingBuffer: the result is read after the caller's own awaits
  // (the exporter's capture race), not in the task that drew it.
  const gl = canvas.getContext('webgl2', {
    alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true,
  });
  if (!gl) return null;
  const shader = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return s;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, shader(gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FRAG));
  gl.bindAttribLocation(prog, 0, 'aPos');
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  // The intermediate keeps the horizontal pass's overshoot when it can (half float).
  const halfFloat = Boolean(gl.getExtension('EXT_color_buffer_float'));
  state = {
    canvas, gl, prog, halfFloat,
    uDir: gl.getUniformLocation(prog, 'uDir'),
    uScale: gl.getUniformLocation(prog, 'uScale'),
    uLast: gl.getUniformLocation(prog, 'uLast'),
    src: null, mid: null, midFb: null, midW: 0, midH: 0,
  };
  return state;
}

const texture = (gl) => {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
};

/**
 * Resample `source` (a canvas — the renderer's, WebGL or WebGPU) to w×h. Read it in
 * the same task as the render that drew it, as drawImage would be. Returns a w×h
 * canvas holding the frame, or null when WebGL2 is unavailable (the caller keeps its
 * 2D resample then).
 */
export function resampleFrame(source, w, h) {
  const s = init();
  if (!s || !source?.width || !source?.height) return null;
  const { gl } = s;
  const sw = source.width;
  const sh = source.height;
  if (s.canvas.width !== w || s.canvas.height !== h) {
    s.canvas.width = w;
    s.canvas.height = h;
  }
  gl.useProgram(s.prog);
  gl.activeTexture(gl.TEXTURE0);
  // Bottom row first, as gl_FragCoord counts, so neither pass flips.
  if (!s.src) s.src = texture(gl);
  gl.bindTexture(gl.TEXTURE_2D, s.src);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  if (!s.mid || s.midW !== w || s.midH !== sh) {
    if (!s.mid) { s.mid = texture(gl); s.midFb = gl.createFramebuffer(); }
    gl.bindTexture(gl.TEXTURE_2D, s.mid);
    if (s.halfFloat) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, sh, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, sh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, s.midFb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, s.mid, 0);
    s.midW = w;
    s.midH = sh;
  }
  // Horizontal: source → w × sh.
  gl.bindFramebuffer(gl.FRAMEBUFFER, s.midFb);
  gl.viewport(0, 0, w, sh);
  gl.bindTexture(gl.TEXTURE_2D, s.src);
  gl.uniform2f(s.uDir, 1, 0);
  gl.uniform1f(s.uScale, sw / w);
  gl.uniform1i(s.uLast, 0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  // Vertical: → w × h, into the canvas.
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, w, h);
  gl.bindTexture(gl.TEXTURE_2D, s.mid);
  gl.uniform2f(s.uDir, 0, 1);
  gl.uniform1f(s.uScale, sh / h);
  gl.uniform1i(s.uLast, 1);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  return s.canvas;
}

/** Free the frame-sized buffers between uses; the context and program stay. */
export function releaseFrameResampler() {
  if (!state || state.gl.isContextLost()) { state = null; return; }
  const { gl } = state;
  if (state.src) gl.deleteTexture(state.src);
  if (state.mid) gl.deleteTexture(state.mid);
  if (state.midFb) gl.deleteFramebuffer(state.midFb);
  state.src = null;
  state.mid = null;
  state.midFb = null;
  state.midW = 0;
  state.midH = 0;
  state.canvas.width = 1;
  state.canvas.height = 1;
}
