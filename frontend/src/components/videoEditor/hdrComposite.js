/*
 * (hdr2) An HDR render through 2D layers: each frame composited a second time, in float.
 *
 * The compositor works in display values, 8 bits a channel, so the 3D Scene's light above white is clipped as soon as it lands in the
 * stack. For an HDR render that has 2D layers with its Scene (hdrScene.js hdrFloatReason says it can), every frame is drawn as always
 * (the 8-bit picture the SDR export has) and then composited once more — the same layers, the same passes, the same blends — with:
 *   - the stack in half floats (renderTargets.js ensureAdjustmentTargets while engine.hdrComposite is set),
 *   - the Scene's plate swapped for its HDR plate: the world's own light (WorldRenderer.hdrPixels) in the compositor's display values,
 *     the sRGB curve carried on above 1, premultiplied by the SDR plate's coverage (compositeNodes.js createHdrPlateNodeMaterial),
 *   - the Scene layer's colour allowed above white (clipShaderNodes.js uRgbMax, lifted only for that plate: layerMesh.js),
 *   - the world drawing nothing new (world3dLayer.js worldReplay): the frame's pose, trace and plate stay as drawn.
 * Every other layer meets it exactly as in the SDR export: below the knee the float composite IS the 8-bit picture (unquantized), and
 * hdrScene.js sameComposite checks that on every new set of layers. The frame is read back as half floats and turned into light.
 *
 * (hdr3) The stack's numbers are display values up to white and LIGHT above it (the plate is encoded so: compositeNodes.js
 * createHdrPlateNodeMaterial), so every blend the SDR export does below white acts on light above it: a 50 % fade of a 1000 cd/m² glint
 * is 500 cd/m². Each frame is also composited with the SDR plate (the same stack, the SDR export's numbers unquantized), and what 2D
 * layers alone push past white there is taken off (createHdrCombineNodeMaterial): only the Scene's light goes above white. An MP4's frame
 * is then encoded on the GPU (hdrEncode.js: 4:2:0 with luma adjustment) and only its planes are read back.
 *
 * A frame averaged over 2D sub-frames (the export's motion blur) averages these float frames (subFrame), so its light is kept. A render at
 * another size than the project's resamples the float picture (Lanczos-3, as frameResampler.js does the SDR frame).
 *
 * WebGPU only (the Scene draws only there). Nothing here exists until an HDR render with a Scene asks; dispose() gives it all back.
 */
import * as THREE from 'three';
import { materials as makeMaterial } from './materialFactory';
import { worldHdrFrame, worldPlate, worldReplay } from './world3dLayer';
import { halfTable, sameComposite } from './hdrScene';
import { releasePoolKey } from './engine/passPool';

const HALF = THREE.HalfFloatType;
// `filtered`: a target a layer samples (the HDR plate: magnified or turned with the Scene layer, as the SDR plate is, linearly); the rest are
// read texel for texel
const floatTarget = (w, h, filtered = false) => {
  const filter = filtered ? THREE.LinearFilter : THREE.NearestFilter;
  const t = new THREE.RenderTarget(Math.max(1, w), Math.max(1, h), { type: HALF, depthBuffer: false, minFilter: filter, magFilter: filter });
  t.texture.colorSpace = THREE.NoColorSpace;
  t.texture.generateMipmaps = false;
  return t;
};
const fit = (t, w, h) => { if (t.width !== w || t.height !== h) t.setSize(w, h); return t; };

/**
 * `width` × `height`: the render's own size (the frames the backend takes). `alpha`: the render keeps coverage. Returns
 * { frame({ accumulated, read8 }), beginAccumulation(n), subFrame(), dispose(), stats } — see each.
 */
export function createHdrComposite(engine, { width, height, alpha = false, encoder = null }) {
  const renderer = engine.renderer;
  const s = {
    hdrTex: null, plateTarget: null, plate: null,      // the world's light uploaded, the HDR plate and its pass
    full: null, ref: null, comb: null,                   // the float composite at the drawing buffer's size: HDR plate, SDR plate, combined
    combs: new Map(),                                    // (hdr3) the combine pass per (SDR, HDR) pair of targets
    subA: null, subB: null, subC: null, accum: null, accumRef: null, accumulating: 0, avg: null, avgRef: null,   // the motion blur's float sub-frames and averages
    rsX: null, rsOut: null, rsPassX: null, rsPassY: null, rsSrc: null,      // the resample to the render's size
    sdrRef: null,                                        // an 8-bit replay for a scaled render's check
    readBuf: null, readBufSize: 0,
    quad: null,
    ms: { sdr: 0, plate: 0, replay: 0, read: 0, n: 0 },
    sdrFrames: 0,                                        // (hdr3) frames that composited the SDR-plate stack too
    disposed: false,
  };
  const ortho = () => engine.orthoCamera;
  const quadScene = (material) => {
    if (!s.quad) s.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    s.quad.material = material;
    s.quad.frustumCulled = false;
    const sc = new THREE.Scene();
    sc.add(s.quad);
    return sc;
  };
  // the renderer's state as the compositor left it (its target, clear colour and autoClear: the next frame's direct path clears with it)
  const keep = () => ({ target: renderer.getRenderTarget(), autoClear: renderer.autoClear, color: renderer.getClearColor(new THREE.Color()), alpha: renderer.getClearAlpha() });
  const restore = (k) => { renderer.setRenderTarget(k.target); renderer.autoClear = k.autoClear; renderer.setClearColor(k.color, k.alpha); };
  const drawInto = (target, material, { clear = true } = {}) => {
    const k = keep();
    const sc = quadScene(material);
    renderer.setRenderTarget(target);
    renderer.autoClear = false;
    if (clear) { renderer.setClearColor(0x000000, 0); renderer.clear(true, false, false); }
    renderer.render(sc, ortho());
    sc.remove(s.quad);
    restore(k);
  };
  const bufferSize = () => {
    const v = renderer.getDrawingBufferSize(new THREE.Vector2());
    return { w: Math.max(1, Math.round(v.x)), h: Math.max(1, Math.round(v.y)) };
  };

  /** The world's light for the frame just drawn, as the compositor's HDR plate, or null (no world picture this frame). */
  async function hdrPlate() {
    const plate = worldPlate(engine);
    if (!plate || plate.sliced) return null;
    const hdr = await worldHdrFrame(engine);
    if (!hdr || hdr.width !== plate.width || hdr.height !== plate.height || hdr.data?.length !== plate.width * plate.height * 4) return null;
    if (!s.hdrTex || s.hdrTex.image.width !== hdr.width || s.hdrTex.image.height !== hdr.height) {
      s.hdrTex?.dispose();
      // a new texture gets a new plate pass (its bindings fixed when made, as every pass here)
      s.plate?.material.dispose();
      s.plate = null;
      s.hdrTex = new THREE.DataTexture(hdr.data, hdr.width, hdr.height, THREE.RGBAFormat, HALF);
      s.hdrTex.colorSpace = THREE.NoColorSpace;
      s.hdrTex.generateMipmaps = false;
    } else {
      s.hdrTex.image.data = hdr.data;
    }
    s.hdrTex.needsUpdate = true;
    s.plateTarget = s.plateTarget ? fit(s.plateTarget, plate.width, plate.height) : floatTarget(plate.width, plate.height, true);
    s.plateTarget.texture.userData.hdrPlate = true;
    // the plate is the SDR plate's layout: same texel, same place (rows top first on both, WorldRenderer.hdrPixels / ensurePlate)
    if (s.plate && s.plateSdr !== plate.texture) { s.plate.material.dispose(); s.plate = null; }
    if (!s.plate) {
      s.plate = makeMaterial.hdrPlate({ hdr: s.hdrTex, sdr: plate.texture, straight: alpha, flip: false, height: plate.height });
      s.plateSdr = plate.texture;
    }
    if (!s.plate) return null;
    s.plate.bind(null, null, plate.height);
    // (hdr3) the Scene layer's grade, read off its draw with the SDR plate (sdrStack), on its light (the slope rule)
    s.plate.setGrade?.(engine.hdrSceneGrade || null);
    drawInto(s.plateTarget, s.plate.material);
    return s.plateTarget.texture;
  }

  /**
   * (hdr3) Whether this frame needs the stack with the SDR plate besides the check: where a 2D layer can push the stack past white by
   * itself (an add blend, Glass's light, Backdrop Blur's saturation over 100 %; every other blend, grade and transition stays within
   * white for colours within white), and where the Scene layer has a grade of its own (read off that draw). Elsewhere it equals the
   * frame with the HDR plate wherever the Scene is within white, so the combine would change nothing and the frame skips it (its GPU work
   * is a whole stack's). `engine.layerItems` / `glassLayers` / `backdropLayers` are the frame just drawn's.
   */
  const GRADE_TRACKS = ['brightness', 'contrast', 'saturate', 'hue-rotate', 'grayscale', 'sepia', 'invert', 'color'];
  const graded = (it) => (Number.isFinite(it.filterBrightness) && it.filterBrightness !== 100) || (Number.isFinite(it.filterContrast) && it.filterContrast !== 100)
    || (Number.isFinite(it.filterSaturation) && it.filterSaturation !== 100) || Math.abs(Number(it.filterHueRotate) || 0) >= 0.5
    || Number(it.filterGrayscale) > 0 || Number(it.filterSepia) > 0 || Number(it.filterInvert) > 0
    || GRADE_TRACKS.some((k) => (it.propertyKeyframes?.[k] || []).length > 0);
  function needsSdrStack() {
    for (const it of engine.layerItems?.values?.() || []) {
      if (!it) continue;
      if (it.blendMode === 'add') return true;
      if (it.rig && graded(it)) return true;
    }
    if (engine.glassLayers?.size) return true;
    for (const b of engine.backdropLayers?.values?.() || []) if (Number(b?.saturation) > 1) return true;
    return false;
  }

  /** (hdr3) The stack with the SDR plate into `target`: the SDR export's numbers, unquantized. The Scene layer's grade is read off it. */
  function sdrStack(target) {
    engine.hdrSdrPlate = worldPlate(engine)?.texture || null;
    engine.hdrSceneGrade = null;
    try {
      replay(target, null);
    } finally {
      engine.hdrSdrPlate = null;
    }
  }

  /**
   * (hdr3) The passes that read the stack and so meet the Scene's light above white, as twins of their own for the float composite:
   * the linear-light draws (a catcher's shadow, a Scene's moving frame over a see-through sky), Backdrop Blur's mix, Glass, the blend pass
   * (overlay, soft light, ... and here multiply and screen) and the adjustment layer's grade. Each is the SDR pass up to white and carries
   * the light above it (compositeNodes.js gradeHybrid, blendCompositeNodes.js blendHybrid). Made on the first frame that composites in
   * float, given back with the render (dispose). The SDR frame's own passes are never touched.
   */
  function twins() {
    if (s.twins) return s.twins;
    const geo = engine.fsQuadGeo;
    const quad = (m) => { const mesh = new THREE.Mesh(geo, m); const scene = new THREE.Scene(); scene.add(mesh); return { mesh, scene }; };
    const obl = makeMaterial.overBlitLinear({ hdr: true });
    const dcl = makeMaterial.depthCompositeLinear({ hdr: true });
    const blur = makeMaterial.backdropBlur();
    const mix = makeMaterial.backdropMix({ hdr: true });
    const mixFlip = makeMaterial.backdropMix({ flipMatte: true, hdr: true });
    const glass = makeMaterial.glass({ hdr: true });
    const plain = makeMaterial.blendComposite({ hdr: true });
    const flip = makeMaterial.blendComposite({ flipLayer: true, hdr: true });
    const adjust = makeMaterial.adjustment({ hdr: true });
    const t = { materials: [obl, dcl, blur, mix, mixFlip, glass, plain, flip, adjust].filter(Boolean) };
    if (obl && geo) t.obl = { material: obl, scene: quad(obl).scene };
    if (dcl && geo) t.dcl = { material: dcl, scene: quad(dcl).scene };
    if (blur && mix && mixFlip && geo) t.backdrop = { blur, mix, mixFlip, ...quad(blur) };
    if (glass && geo) t.glass = { material: glass, ...quad(glass) };
    if (plain && flip && geo) t.blend = { plain, flip, ...quad(plain) };
    t.adjust = adjust;
    s.twins = t;
    return t;
  }
  const swapIn = () => {
    const t = twins();
    const mesh = engine.adjustmentClipMesh;
    const was = { obls: engine.overBlitLinearScene, oblm: engine.overBlitLinearMaterial, dcls: engine.depthCompositeLinearScene,
      dclm: engine.depthCompositeLinearMaterial, backdrop: engine.backdropPass, glass: engine.glassPass, blend: engine.blendPass, adjust: mesh?.material };
    if (t.obl) { engine.overBlitLinearScene = t.obl.scene; engine.overBlitLinearMaterial = t.obl.material; }
    if (t.dcl) { engine.depthCompositeLinearScene = t.dcl.scene; engine.depthCompositeLinearMaterial = t.dcl.material; }
    if (t.backdrop) engine.backdropPass = t.backdrop;
    if (t.glass) engine.glassPass = t.glass;
    if (t.blend) engine.blendPass = t.blend;
    if (t.adjust && mesh) mesh.material = t.adjust;
    return () => {
      engine.overBlitLinearScene = was.obls; engine.overBlitLinearMaterial = was.oblm;
      engine.depthCompositeLinearScene = was.dcls; engine.depthCompositeLinearMaterial = was.dclm;
      engine.backdropPass = was.backdrop; engine.glassPass = was.glass; engine.blendPass = was.blend;
      if (mesh && was.adjust) mesh.material = was.adjust;
    };
  };

  /**
   * The frame just drawn, composited again into `target`: the stack in half floats, the Scene's plate `plateTex` (null: the world drew
   * nothing this frame, its layer keeps the SDR picture it has), the world drawing nothing new. `hdr` false: the same replay in 8 bits (a
   * scaled render's reference for its check). (hdr3) A catcher's shadow and a Scene's frame over a see-through sky go over the stack in
   * linear light through their float twins, so those frames keep the Scene's light too.
   */
  function replay(target, plateTex, hdr = true) {
    const prevOut = engine.outputTarget;
    const k = keep();
    worldReplay({ texture: hdr ? plateTex : null });
    engine.hdrComposite = hdr;
    engine.outputTarget = target;
    const swapOut = hdr ? swapIn() : null;
    try {
      engine.renderFrame();
    } finally {
      swapOut?.();
      engine.hdrComposite = false;
      engine.outputTarget = prevOut;
      worldReplay(null);
      restore(k);
    }
    return { clipped: null };
  }

  /** (hdr3) `b` (the stack with the HDR plate) less what 2D layers alone pushed past white in `a` (the same stack with the SDR plate),
   *  into `into`. */
  function combine(a, b, into) {
    const key = `${a.texture.id}:${b.texture.id}`;
    let m = s.combs.get(key);
    if (!m) { m = makeMaterial.hdrCombine({ a: a.texture, b: b.texture }); s.combs.set(key, m); }
    drawInto(into, m.material);
    return into;
  }

  /** `src` (a float target at the drawing buffer's size) at the render's size: itself, or its Lanczos resample. */
  function atRenderSize(src) {
    if (src.width === width && src.height === height) return src;
    if (s.rsSrc !== src) {
      s.rsPassX?.material.dispose(); s.rsPassY?.material.dispose();
      s.rsX = s.rsX || floatTarget(width, src.height);
      s.rsOut = s.rsOut || floatTarget(width, height);
      s.rsPassX = makeMaterial.hdrResample(src.texture, { horizontal: true });
      s.rsPassY = makeMaterial.hdrResample(s.rsX.texture, { horizontal: false });
      s.rsSrc = src;
    }
    fit(s.rsX, width, src.height);
    fit(s.rsOut, width, height);
    s.rsPassX.bind({ scale: src.width / width, width: src.width, height: src.height });
    drawInto(s.rsX, s.rsPassX.material);
    s.rsPassY.bind({ scale: src.height / height, width, height: src.height });
    drawInto(s.rsOut, s.rsPassY.material);
    return s.rsOut;
  }

  /** A target's texels into the page, rows top first (storage order), through a buffer kept for the render. */
  async function readTarget(target, bytesPerTexel = 8) {
    const device = renderer.backend?.device;
    const gpuTexture = renderer.backend?.get?.(target.texture)?.texture;
    if (!device || !gpuTexture) throw new Error('the float composite could not be read (no WebGPU texture)');
    const w = target.width, h = target.height;
    const row = w * bytesPerTexel, stride = Math.ceil(row / 256) * 256, size = stride * h;
    if (!s.readBuf || s.readBufSize < size) {
      s.readBuf?.destroy();
      s.readBuf = device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      s.readBufSize = size;
    }
    const buf = s.readBuf;
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture: gpuTexture }, { buffer: buf, bytesPerRow: stride }, { width: w, height: h });
    device.queue.submit([encoder.finish()]);
    await buf.mapAsync(GPUMapMode.READ, 0, size);
    const src = new Uint8Array(buf.getMappedRange(0, size));
    const out = new Uint8Array(row * h);
    if (stride === row) out.set(src.subarray(0, row * h));
    else for (let y = 0; y < h; y += 1) out.set(src.subarray(y * stride, y * stride + row), y * row);
    buf.unmap();
    return out;
  }

  /**
   * A float average of sub-frames: the first one as it is (`base`), then each next one's difference from it at its weight (`delta`), so a
   * pixel that does not move stays its first sub-frame to the bit; `result(into)` writes base + delta. Half floats summing sixteen whole
   * values near white lost about 1 % (the 100x emitter 1004 -> 994 cd/m²), and float32 targets need a blend feature WebGPU may not have.
   */
  const averager = () => ({ base: null, delta: null, n: 0, weight: 1, mats: null });
  // each pass its own material, its textures and numbers fixed when made: one material re-bound between draws read a stale binding (the
  // differences pass came out empty, the blurred title sharp)
  const passOf = (a, b, sub, weight) => {
    const m = makeMaterial.hdrAccumulate({ a: a.texture, b: b.texture });
    m.material.uniforms.uSub.value = sub;
    m.material.uniforms.uWeight.value = weight;
    return m.material;
  };
  const accumulate = (avg, src, w, h) => {
    avg.base = avg.base ? fit(avg.base, w, h) : floatTarget(w, h);
    avg.delta = avg.delta ? fit(avg.delta, w, h) : floatTarget(w, h);
    if (!avg.mats || avg.mats.src !== src || avg.mats.weight !== avg.weight) {
      disposePasses(avg);
      avg.mats = { src, weight: avg.weight, pass: { copy: passOf(src, src, 0, 1), diff: passOf(src, avg.base, 1, avg.weight),
        outBase: passOf(avg.base, avg.base, 0, 1), outDelta: passOf(avg.delta, avg.delta, 0, 1) } };
    }
    if (avg.n === 0) {
      clearTarget(avg.delta);
      drawInto(avg.base, avg.mats.pass.copy);
    } else {
      drawInto(avg.delta, avg.mats.pass.diff, { clear: false });
    }
    avg.n += 1;
  };
  const averaged = (avg, into) => {
    drawInto(into, avg.mats.pass.outBase);
    drawInto(into, avg.mats.pass.outDelta, { clear: false });
    return into;
  };
  const disposePasses = (avg) => { for (const m of Object.values(avg?.mats?.pass || {})) m.dispose(); };

  const clearTarget = (t) => {
    const k = keep();
    renderer.setRenderTarget(t);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, false, false);
    restore(k);
  };

  /** The HDR plate against the SDR plate it stands in for, where the SDR picture is darker than 200 of 255 (below every view's knee, where
   *  the world's HDR light is the SDR light: hdrscene): the same picture, the same way up. Highlights are not compared. */
  async function plateCheck() {
    const plate = worldPlate(engine);
    if (!plate || !s.plateTarget) return { same: true, skipped: true };
    const sdr = await readTarget({ texture: plate.texture, width: plate.width, height: plate.height }, 4);
    // (hdr3) the plate as the world gave it: a Scene layer's grade is drawn into it, so the check draws it once more ungraded
    let checked = s.plateTarget;
    if (s.plate?.material?.uniforms?.uGrade?.value > 0.5) {
      s.plateUngraded = s.plateUngraded ? fit(s.plateUngraded, s.plateTarget.width, s.plateTarget.height) : floatTarget(s.plateTarget.width, s.plateTarget.height);
      s.plate.setGrade(null);
      drawInto(s.plateUngraded, s.plate.material);
      s.plate.setGrade(engine.hdrSceneGrade || null);
      checked = s.plateUngraded;
    }
    const enc = new Uint16Array((await readTarget(checked)).buffer);
    const t = halfTable();
    let diff = 0, off = 0, n = 0, offPartial = 0, offRows = 0, coverSum = 0;
    const box = [1e9, 1e9, -1, -1], sdrSum = [0, 0, 0], hdrSum = [0, 0, 0];
    const w = s.plateTarget.width;
    for (let i = 0; i < enc.length; i += 4) {
      if (sdr[i] > 200 || sdr[i + 1] > 200 || sdr[i + 2] > 200) continue;
      let far = false;
      for (let c = 0; c < 3; c += 1) {
        const d = Math.abs(sdr[i + c] - t[enc[i + c]] * 255);
        diff += d;
        if (d > 3) far = true;
      }
      if (far) {
        off += 1;
        // (hdr3) where the pixels that differ are, for the console: partly covered, and their mean row (a flipped plate differs top and bottom)
        if (sdr[i + 3] < 255) offPartial += 1;
        const px = (i / 4) % w, py = Math.floor(i / 4 / w);
        offRows += py;
        coverSum += sdr[i + 3] / 255;
        box[0] = Math.min(box[0], px); box[1] = Math.min(box[1], py); box[2] = Math.max(box[2], px); box[3] = Math.max(box[3], py);
        for (let c = 0; c < 3; c += 1) { sdrSum[c] += sdr[i + c]; hdrSum[c] += t[enc[i + c]] * 255; }
      }
      n += 1;
    }
    const meanDiff = diff / (3 * Math.max(1, n)), share = off / Math.max(1, n);
    const res = { same: meanDiff < 0.75 && share < 0.002, meanDiff, off: share, compared: n / Math.max(1, enc.length / 4) };
    if (!res.same) {
      console.warn('[hdr3] plate check: ' + JSON.stringify({ meanDiff, share, partly: off ? offPartial / off : 0, meanRow: off ? offRows / off : 0,
        meanCover: off ? coverSum / off : 0, height: s.plateTarget.height, box, sdr: sdrSum.map((v) => Math.round(v / Math.max(1, off))),
        hdr: hdrSum.map((v) => Math.round(v / Math.max(1, off))) }));
    }
    return res;
  }

  const now = () => performance.now();

  return {
    /**
     * The frame just drawn as the float composite at the render's size: { data: rgba half floats (display values, premultiplied, rows top
     * first), scene: whether the Scene's light was in it, clipped, check? }. `accumulated`: the frame was averaged over 2D sub-frames — its
     * float average (subFrame) is the frame. `read8`: the compositor's 8-bit picture at the render's size, given when this set of layers is
     * to be checked. The check is like for like: the same frame composited in float with the Scene's SDR plate (so a fade, a dark card or a
     * blur over a highlight, which rightly differ once the highlight is there, do not count) against the 8-bit picture — the stack in
     * float reproduces the SDR export — and, once a render, the HDR plate against the SDR plate below the knee (the same picture, the
     * same way up). A scaled render compares at the drawing buffer's size, against an 8-bit replay (its SDR frame's own resample is the
     * 2D canvas's, not this one).
     */
    async frame({ accumulated = false, read8 = null } = {}) {
      if (s.disposed) return null;
      const t0 = now();
      let src, scene, clipped = null, ref = null;
      const { w, h } = bufferSize();
      if (accumulated && s.accumulating && s.avg.n) {
        s.accum = s.accum ? fit(s.accum, w, h) : floatTarget(w, h);
        src = averaged(s.avg, s.accum);
        scene = s.accumScene;
        clipped = s.accumClipped;
        if (s.avgRef.n) {
          s.accumRef = s.accumRef ? fit(s.accumRef, w, h) : floatTarget(w, h);
          ref = averaged(s.avgRef, s.accumRef);
        }
        s.accumulating = 0;
      } else {
        // (hdr3) the stack with the SDR plate: the check's reference, what 2D layers alone push past white, the Scene layer's grade
        const withSdr = !!read8 || needsSdrStack();
        if (withSdr) {
          s.ref = s.ref ? fit(s.ref, w, h) : floatTarget(w, h);
          sdrStack(s.ref);
          ref = s.ref;
          s.sdrFrames += 1;
        } else {
          engine.hdrSceneGrade = null;
        }
        const tA = now();
        s.ms.sdr += tA - t0;
        const plateTex = await hdrPlate();
        const t1 = now();
        s.ms.plate += t1 - tA;
        s.full = s.full ? fit(s.full, w, h) : floatTarget(w, h);
        ({ clipped } = replay(s.full, plateTex));
        if (withSdr) {
          s.comb = s.comb ? fit(s.comb, w, h) : floatTarget(w, h);
          src = combine(s.ref, s.full, s.comb);
        } else {
          src = s.full;
        }
        s.ms.replay += now() - t1;
        scene = !!plateTex && !clipped;
      }
      const t2 = now();
      let check;
      if (read8 && ref) {
        const float8 = new Uint16Array((await readTarget(ref)).buffer);
        if (ref.width === width && ref.height === height) {
          check = sameComposite(read8(), float8, { alpha });
        } else if (!accumulated) {
          s.sdrRef = s.sdrRef ? fit(s.sdrRef, w, h) : new THREE.RenderTarget(w, h, { type: THREE.UnsignedByteType, depthBuffer: false });
          replay(s.sdrRef, null, false);
          check = sameComposite(await readTarget(s.sdrRef, 4), float8, { alpha: false });
        }
        if (check && scene && !s.plateChecked) {
          s.plateChecked = true;
          check.plate = await plateCheck();
          if (!check.plate.same) check.same = false;
        }
      }
      const out = atRenderSize(src);
      // (hdr3) an MP4's frame encoded where it is (4:2:0, luma-adjusted), only its planes read back; ProRes reads the float frame
      let data = null, yuv = null;
      if (encoder) yuv = await encoder.encodeTexture(out, { hybrid: true });
      else data = new Uint16Array((await readTarget(out)).buffer);
      s.ms.read += now() - t2;
      s.ms.n += 1;
      return { data, yuv, scene, clipped, ...(check ? { check } : {}) };
    },
    /** A frame of `n` 2D sub-frames starts (motionBlur.js renderAccumulated's own count): the float average starts empty. */
    beginAccumulation(n) {
      if (s.disposed) return;
      const weight = 1 / Math.max(1, n);
      const next = (old) => ({ ...averager(), base: old?.base || null, delta: old?.delta || null, mats: old?.mats || null, weight });
      s.avg = next(s.avg);
      s.avgRef = next(s.avgRef);
      s.accumulating = 1;
      s.accumScene = false;
      s.accumClipped = null;
    },
    /** After one sub-frame is drawn: its float composite, added into the average at its weight. `check`: this frame's set of layers is
     *  to be checked, so its SDR-plate float composite is averaged beside it (the reference frame() compares with the 8-bit average). */
    async subFrame(check = false) {
      if (s.disposed || !s.accumulating) return;
      const { w, h } = bufferSize();
      for (const k of ['subA', 'subB', 'subC']) s[k] = s[k] ? fit(s[k], w, h) : floatTarget(w, h);
      // (hdr3) each sub-frame combined where it needs it (the HDR-plate stack less the SDR-plate stack's 2D overflow past white), then
      // averaged; a check needs every sub-frame's SDR-plate float composite: one that starts late compares nothing
      const checking = check && (s.avgRef.n > 0 || s.avg.n === 0);
      const withSdr = checking || needsSdrStack();
      if (withSdr) sdrStack(s.subA); else engine.hdrSceneGrade = null;
      if (checking) accumulate(s.avgRef, s.subA, w, h);
      const plateTex = await hdrPlate();
      const { clipped } = replay(s.subB, plateTex);
      if (plateTex && !clipped) s.accumScene = true;
      if (clipped) s.accumClipped = clipped;
      accumulate(s.avg, withSdr ? combine(s.subA, s.subB, s.subC) : s.subB, w, h);
    },
    /** Where a frame's time went, ms a frame: (hdr3) the stack with the SDR plate, the HDR plate (the world's light read and uploaded), the
     *  replay with it and the combine, the read-back (an MP4's: the GPU encode and its planes). */
    stats() {
      const n = Math.max(1, s.ms.n);
      const r = (v) => Math.round((v / n) * 10) / 10;
      return { sdr: r(s.ms.sdr), plate: r(s.ms.plate), replay: r(s.ms.replay), read: r(s.ms.read), withSdr: s.sdrFrames };
    },
    dispose() {
      if (s.disposed) return;
      s.disposed = true;
      for (const t of [s.plateTarget, s.plateUngraded, s.full, s.ref, s.comb, s.subA, s.subB, s.subC, s.accum, s.accumRef, s.avg?.base, s.avg?.delta, s.avgRef?.base, s.avgRef?.delta, s.rsX, s.rsOut, s.sdrRef]) t?.dispose();
      for (const m of [s.plate, s.rsPassX, s.rsPassY, ...s.combs.values()]) m?.material?.dispose();
      s.combs.clear();
      for (const m of s.twins?.materials || []) m.dispose();
      s.twins = null;
      // (hdr3) the float composite's own pooled stack copies (engine/passPool.js `hdr:` slots): given back with the render
      for (const key of [...(engine.passPool?.keys() || [])]) if (key.startsWith('hdr:')) releasePoolKey(engine, key);
      encoder?.dispose();
      disposePasses(s.avg);
      disposePasses(s.avgRef);
      s.hdrTex?.dispose();
      s.quad?.geometry.dispose();
      s.readBuf?.destroy();
      const rt = engine.adjustmentRTHdr;
      if (rt) { for (const k of ['a', 'b', 'c', 'd', 'e', 'f']) rt[k]?.dispose(); engine.adjustmentRTHdr = null; }
      worldReplay(null);
    },
  };
}
