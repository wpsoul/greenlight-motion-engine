/*
 * PROVING AN EFFECT PACKAGE — one real compile and one real render per engine,
 * once per installed revision (localEffects.js decides when).
 *
 * Why a render and not a parse. A GLSL check in a test context misses what only
 * the real compiler sees, and WebGPU is worse: a WGSL error does not throw — the
 * pipeline is silently invalid and the layer draws NOTHING, with the cause
 * swallowed (see the WebGPU invalid-pipeline notes). The only honest proof is to
 * build the material the chain would build, draw it, and listen where each
 * engine actually reports:
 *
 *   WebGL  — a private WebGL2 context; three's `debug.onShaderError` hands over
 *            the driver's info log, which is quoted with the offending line.
 *   WebGPU — a PRIVATE device (never the editor's), so its error scope and the
 *            `getCompilationInfo()` of every shader module it created belong to
 *            this proof alone; the TSL graph is also built eagerly first, so a
 *            JS mistake in `fragmentNode` names itself.
 *
 * The render is the chain's: the same material factories, the same uniforms
 * (applyEffectUniforms), passes walked by name the way runEffectChain walks
 * them, over a quad-written source plate. It draws an asymmetric test picture at
 * 960×540 with the package's default params — and that picture, scaled down, is
 * the package's thumbnail.
 *
 * Read-back rows come back bottom-up on one engine and top-down on the other;
 * rather than assume, the proof reads its own source plate back too and keeps
 * whichever row order matches the picture it drew.
 *
 * Everything is created and destroyed per call: nothing here stays resident, and
 * the editor's own renderer is never touched.
 */
import * as THREE from 'three';
import { applyEffectUniforms, createEffectMaterial } from './adjustmentEffects';
import { loadPackageProofNodes } from './materialFactory';
import { probeWebGpuAdapter } from './videoRenderer';

const W = 960;
const H = 540;
const THUMB_W = 384;
const THUMB_H = 216;
const PROOF_TIME = 1;

// ── The test picture ───────────────────────────────────────────────────────
// Colour for grades, edges for blurs and keys, text and an off-centre sun so a
// flipped or mirrored result is obvious. Opaque, so it is its own premultiplied
// form.
let pictureCache = null;
function testPicture() {
  if (pictureCache) return pictureCache;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const x = canvas.getContext('2d');
  const sky = x.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, '#1b2a6b');
  sky.addColorStop(0.55, '#c0587e');
  sky.addColorStop(1, '#f6b26b');
  x.fillStyle = sky;
  x.fillRect(0, 0, W, H);
  x.fillStyle = '#ffd36e';
  x.beginPath();
  x.arc(W * 0.74, H * 0.36, H * 0.15, 0, Math.PI * 2);
  x.fill();
  x.fillStyle = '#183a3a';
  x.beginPath();
  x.moveTo(0, H);
  x.lineTo(0, H * 0.72);
  x.lineTo(W * 0.22, H * 0.55);
  x.lineTo(W * 0.42, H * 0.74);
  x.lineTo(W * 0.63, H * 0.6);
  x.lineTo(W, H * 0.78);
  x.lineTo(W, H);
  x.closePath();
  x.fill();
  x.fillStyle = '#ffffff';
  x.font = `700 ${Math.round(H * 0.3)}px Arial, sans-serif`;
  x.textBaseline = 'alphabetic';
  x.fillText('Aa', W * 0.07, H * 0.42);
  x.fillStyle = '#40e0b0';
  x.fillRect(W * 0.07, H * 0.47, W * 0.2, H * 0.035);
  pictureCache = { canvas, data: x.getImageData(0, 0, W, H).data };
  return pictureCache;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function defaultInstance(def) {
  const params = {};
  for (const p of def.params) params[p.key] = p.default;
  return { id: def.id, eid: 'proof', enabled: true, mix: 100, params };
}

// The package as the proof uses it: its own image specs, so the textures it
// makes on a private context never land on the ones the editor uses.
function proofCopy(def) {
  return { ...def, textures: (def.textures || []).map((t) => ({ ...t, glTexture: null, gpuTexture: null })) };
}

function releaseCopy(copy) {
  for (const t of copy.textures) {
    t.glTexture?.dispose();
    t.gpuTexture?.dispose();
  }
}

// Mean |difference| per channel between two RGBA buffers on a coarse grid.
function meanDiff(a, b, flipB = false) {
  let sum = 0;
  let n = 0;
  for (let y = 4; y < H; y += 8) {
    const by = flipB ? H - 1 - y : y;
    for (let xx = 4; xx < W; xx += 8) {
      const i = (y * W + xx) * 4;
      const j = (by * W + xx) * 4;
      sum += Math.abs(a[i] - b[j]) + Math.abs(a[i + 1] - b[j + 1]) + Math.abs(a[i + 2] - b[j + 2]) + Math.abs(a[i + 3] - b[j + 3]);
      n += 4;
    }
  }
  return sum / n;
}

function flipRows(buffer) {
  const out = new Uint8ClampedArray(buffer.length);
  const row = W * 4;
  for (let y = 0; y < H; y++) out.set(buffer.subarray((H - 1 - y) * row, (H - y) * row), y * row);
  return out;
}

async function thumbnailBlob(rgba) {
  const full = document.createElement('canvas');
  full.width = W;
  full.height = H;
  full.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba), W, H), 0, 0);
  const small = document.createElement('canvas');
  small.width = THUMB_W;
  small.height = THUMB_H;
  const x = small.getContext('2d');
  x.imageSmoothingQuality = 'high';
  x.drawImage(full, 0, 0, THUMB_W, THUMB_H);
  return new Promise((resolve) => small.toBlob((blob) => resolve(blob), 'image/webp', 0.86));
}

// What the pictures say about the package, beyond "it compiled".
function judge(def, source, output, outputLater) {
  const warnings = [];
  let maxAlpha = 0;
  for (let i = 3; i < output.length; i += 16) if (output[i] > maxAlpha) maxAlpha = output[i];
  if (maxAlpha < 2) {
    warnings.push('Draws nothing at its default settings: the whole output is transparent over an opaque picture.');
  } else if (meanDiff(source, output) < 0.25) {
    warnings.push('Changes nothing at its default settings: the output equals the input.');
  }
  if (def.animated && outputLater && meanDiff(output, outputLater) < 0.05) {
    warnings.push('`animated` is true, but the picture does not change over time — set `animated: false` if it never reads time.');
  }
  return warnings;
}

// ── The render, shared by both engines ─────────────────────────────────────
// `kit`: { T (three namespace), RenderTarget, renderer, makeMaterial(def, pass),
// makePlate(T, pictureTex) → { material, texture }, read(target) }.
async function renderProof(kit, def) {
  const { T, renderer } = kit;
  const picture = testPicture();
  const { material: blit, texture: pictureTex } = kit.makePlate(T, picture.canvas);
  const geometry = new T.PlaneGeometry(2, 2);
  const camera = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const scene = new T.Scene();
  const mesh = new T.Mesh(geometry, blit);
  scene.add(mesh);
  const targets = [];
  const makeTarget = (w, h) => {
    const rt = new kit.RenderTarget(w, h, { depthBuffer: false, stencilBuffer: false });
    rt.texture.minFilter = T.LinearFilter;
    rt.texture.magFilter = T.LinearFilter;
    targets.push(rt);
    return rt;
  };
  const materials = new Map();
  const draw = (material, target) => {
    mesh.material = material;
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, true);
    renderer.render(scene, camera);
  };
  try {
    const source = makeTarget(W, H);
    draw(blit, source);
    const eff = defaultInstance(def);
    const passes = def.passes || [{ key: 'main', main: true, single: true, inputs: { uTexture: 'source' } }];
    const runAt = (time) => {
      const buffers = { source: source.texture, matte: source.texture };
      let out = null;
      for (const pass of passes) {
        const passName = pass.single ? 'main' : `pass:${pass.key}`;
        let material = materials.get(passName);
        if (!material) {
          material = kit.makeMaterial(def, passName);
          if (!material) throw Object.assign(new Error(`no material for ${pass.single ? 'the effect' : `pass "${pass.label}"`}`), { stage: 'material' });
          materials.set(passName, material);
        }
        const scale = pass.main ? 1 : (pass.scale ?? 1);
        const sx = Array.isArray(scale) ? scale[0] : scale;
        const sy = Array.isArray(scale) ? scale[1] : scale;
        const w = Math.max(1, Math.round(W * sx));
        const h = Math.max(1, Math.round(H * sy));
        applyEffectUniforms(material, eff, { time, progress: 0.5, width: w, height: h, quality: 1, mix: 1, box: null }, def);
        const u = material.uniforms;
        if (u.uSource) u.uSource.value = buffers.source;
        for (const [uniform, name] of Object.entries(pass.inputs || {})) if (u[uniform]) u[uniform].value = buffers[name] ?? null;
        const target = pass.main ? (out = out || makeTarget(W, H)) : makeTarget(w, h);
        draw(material, target);
        if (!pass.main) buffers[pass.key] = target.texture;
        else out = target;
      }
      return out;
    };
    const sourcePixels = await kit.read(source);
    const outA = runAt(PROOF_TIME);
    const outputPixels = await kit.read(outA);
    let laterPixels = null;
    if (def.animated) {
      const outB = runAt(PROOF_TIME + 1.37);
      laterPixels = await kit.read(outB);
    }
    // Keep the row order that shows the picture the way it was drawn.
    const upright = meanDiff(picture.data, sourcePixels) <= meanDiff(picture.data, sourcePixels, true);
    const fix = (buf) => (buf && !upright ? flipRows(buf) : buf && new Uint8ClampedArray(buf));
    return { source: fix(sourcePixels), output: fix(outputPixels), later: fix(laterPixels) };
  } finally {
    for (const material of materials.values()) material.dispose();
    for (const rt of targets) rt.dispose();
    blit.dispose();
    pictureTex.dispose();
    geometry.dispose();
  }
}

// ── WebGL ──────────────────────────────────────────────────────────────────

function sourceLine(gl, shader, log) {
  const match = /ERROR:\s*\d+:(\d+):/.exec(log || '');
  if (!match) return '';
  const lines = (gl.getShaderSource(shader) || '').split('\n');
  const text = lines[Number(match[1]) - 1];
  return text ? ` — at: ${text.trim()}` : '';
}

async function proveWebGl(def) {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: false });
  } catch (error) {
    return { skipped: `WebGL is not available here (${error?.message || error})` };
  }
  const shaderErrors = [];
  renderer.debug.checkShaderErrors = true;
  renderer.debug.onShaderError = (gl, program, glVertex, glFragment) => {
    const fragLog = gl.getShaderInfoLog(glFragment) || '';
    const vertLog = gl.getShaderInfoLog(glVertex) || '';
    const log = (fragLog || vertLog || gl.getProgramInfoLog(program) || 'the program did not link').replace(/\u0000/g, '').trim();
    shaderErrors.push(`${log.split('\n')[0]}${sourceLine(gl, fragLog ? glFragment : glVertex, log)}`);
  };
  const gl = renderer.getContext();
  const kit = {
    T: THREE,
    RenderTarget: THREE.WebGLRenderTarget,
    renderer,
    // A plain textured quad: on WebGL that IS the chain's plate orientation
    // (gl_FragCoord-based uv reads it upright).
    makePlate: (T, canvas) => {
      const texture = new T.CanvasTexture(canvas);
      texture.colorSpace = T.NoColorSpace;
      return { texture, material: new T.MeshBasicMaterial({ map: texture, toneMapped: false }) };
    },
    makeMaterial: (d, pass) => createEffectMaterial(d, undefined, pass),
    read: async (target) => {
      const buf = new Uint8Array(W * H * 4);
      renderer.readRenderTargetPixels(target, 0, 0, W, H, buf);
      return buf;
    },
  };
  try {
    const result = await renderProof(kit, def);
    if (shaderErrors.length) return { error: `GLSL: ${shaderErrors[0]}`, stage: 'glsl-compile' };
    const glError = gl.getError();
    if (glError !== gl.NO_ERROR && glError !== gl.CONTEXT_LOST_WEBGL) {
      return { error: `the draw failed with WebGL error 0x${glError.toString(16)}`, stage: 'render' };
    }
    return { result };
  } catch (error) {
    if (shaderErrors.length) return { error: `GLSL: ${shaderErrors[0]}`, stage: 'glsl-compile' };
    return { error: String(error?.message || error), stage: error?.stage || 'render' };
  } finally {
    renderer.dispose();
    renderer.forceContextLoss();
  }
}

// ── WebGPU ─────────────────────────────────────────────────────────────────

function wgslMessage(message, code) {
  const line = code ? code.split('\n')[message.lineNum - 1] : '';
  return `${message.message}${line ? ` — at: ${line.trim()}` : ''}`;
}

async function proveWebGpu(def) {
  const probe = await probeWebGpuAdapter();
  if (!probe.ok) return { skipped: `WebGPU is not available here (${probe.reason})` };
  let nodes;
  try {
    nodes = await loadPackageProofNodes();
  } catch (error) {
    return { skipped: `the WebGPU renderer could not load (${error?.message || error})` };
  }
  const built = nodes.adj.validatePackageEffectBody(def);
  if (built) return { error: `TSL: ${built}`, stage: 'tsl' };

  let device;
  try {
    device = await probe.adapter.requestDevice();
  } catch (error) {
    return { skipped: `could not create a WebGPU device (${error?.message || error})` };
  }
  // Every module this device compiles, kept for its compilation info.
  const modules = [];
  const createShaderModule = device.createShaderModule.bind(device);
  device.createShaderModule = (descriptor) => {
    const module = createShaderModule(descriptor);
    modules.push({ module, code: descriptor?.code || '' });
    return module;
  };
  const uncaptured = [];
  device.addEventListener('uncapturederror', (event) => uncaptured.push(String(event?.error?.message || event?.error || 'GPU error')));
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const T = nodes.THREE;
  const renderer = new T.WebGPURenderer({ canvas, alpha: true, antialias: false });
  // Same reason as videoRenderer.js: a failed init must not fall back to WebGL2.
  if ('_getFallback' in renderer) renderer._getFallback = null;
  if (renderer.backend?.parameters) renderer.backend.parameters.device = device;
  try {
    await renderer.init();
    if (renderer.backend?.isWebGPUBackend !== true) return { skipped: 'three did not start its WebGPU backend' };
    renderer.setSize(W, H, false);
    device.pushErrorScope('validation');
    let result = null;
    let thrown = null;
    try {
      result = await renderProof({
        T,
        RenderTarget: T.RenderTarget,
        renderer,
        // The chain's WebGPU plates are QUAD-WRITTEN: they read upright under the
        // screen-space uv every effect samples with, which on this backend means
        // they are stored V-mirrored against a camera render (three reads a
        // render target mirrored under screen uv). A camera-rendered textured
        // quad therefore reached the effect upside down — measured: the proof's
        // directional effects came out reversed against the editor. So the plate
        // is stored the way the chain stores one.
        makePlate: (TT, canvas) => {
          const { texture: tex, screenCoordinate, uniform, vec2, float } = nodes.TSL;
          const texture = new TT.CanvasTexture(canvas);
          texture.colorSpace = TT.NoColorSpace;
          texture.flipY = false;
          const material = new TT.MeshBasicNodeMaterial();
          const at = screenCoordinate.xy.div(uniform(new TT.Vector2(W, H)));
          material.fragmentNode = tex(texture, vec2(at.x, float(1.0).sub(at.y)));
          material.depthTest = false;
          material.depthWrite = false;
          return { texture, material };
        },
        makeMaterial: (d, pass) => nodes.adj.createEffectNodeMaterial(d.id, pass, null, d),
        read: async (target) => new Uint8Array(await renderer.readRenderTargetPixelsAsync(target, 0, 0, W, H)),
      }, def);
    } catch (error) {
      thrown = error;
    }
    await device.queue.onSubmittedWorkDone();
    const scopeError = await device.popErrorScope();
    const compileErrors = [];
    for (const { module, code } of modules) {
      const info = await module.getCompilationInfo();
      for (const message of info.messages) if (message.type === 'error') compileErrors.push(wgslMessage(message, code));
    }
    if (compileErrors.length) return { error: `WGSL: ${compileErrors[0]}`, stage: 'wgsl' };
    if (scopeError) return { error: `WebGPU validation: ${scopeError.message}`, stage: 'wgsl' };
    if (uncaptured.length) return { error: `WebGPU: ${uncaptured[0]}`, stage: 'wgsl' };
    if (thrown) return { error: `TSL: ${String(thrown?.message || thrown)}`, stage: thrown?.stage || 'tsl' };
    return { result };
  } catch (error) {
    return { error: String(error?.message || error), stage: 'render' };
  } finally {
    try { renderer.dispose(); } catch { /* the device goes next anyway */ }
    try { device.destroy(); } catch { /* no-op */ }
  }
}

// ── Entry ──────────────────────────────────────────────────────────────────

/**
 * Prove one engine. Resolves { ok, error?, stage?, skipped?, warnings, thumbnail? }
 * and never throws: a proof that cannot run says so (`skipped`), it does not
 * fail the package.
 */
export async function proveEffect(def, engine) {
  const copy = proofCopy(def);
  try {
    const run = engine === 'webgpu' ? await proveWebGpu(copy) : await proveWebGl(copy);
    if (run.skipped) return { ok: false, skipped: run.skipped, warnings: [] };
    if (run.error) return { ok: false, error: run.error, stage: run.stage, warnings: [] };
    const { source, output, later } = run.result;
    const warnings = judge(def, source, output, later);
    let thumbnail = null;
    try { thumbnail = await thumbnailBlob(output); } catch { /* the check stands without a picture */ }
    return { ok: true, warnings, thumbnail };
  } catch (error) {
    return { ok: false, error: String(error?.message || error), stage: 'render', warnings: [] };
  } finally {
    releaseCopy(copy);
  }
}
