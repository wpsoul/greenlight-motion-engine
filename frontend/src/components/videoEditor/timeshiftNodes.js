/*
 * TSL twins of timeshiftMaterial.js.
 *
 *   createTimeShiftRecordNodeMaterial()  ← createTimeShiftRecordMaterial()
 *   createTimeShiftStreakNodeMaterial()  ← createTimeShiftStreakMaterial()
 *
 * A missing twin is a SILENT no-op on WebGPU, not an error — getEffectMaterial's
 * caller does `if (!mat) continue` — so both halves live here and are kept in the
 * same order as the GLSL so a diff between the two files is readable.
 *
 * ORIENTATION. Every plate on this path was written by one of these quad passes,
 * so the uv is plain `screenCoordinate` with no V flip, exactly as echoNodes.js
 * documents. The overlay chain hands the effect a quad-written plate; there is
 * no camera-rendered input anywhere on this path.
 *
 * THE ONE PLACE THIS COSTS MORE THAN THE GLSL. `ringAt` picks between the
 * full-res plate and an atlas tile. GLSL writes that as a ternary with an early
 * return; a node graph has no early return, so both sides are built and selected
 * between. In practice the GPU fetches both sides of a non-uniform branch anyway,
 * so the two backends land in the same place — but if a fetch budget is ever the
 * problem, this is where it is being spent.
 */
import * as THREE from 'three/webgpu';
import {
  Fn, If, Break, Loop, Discard, uniform, float, int, vec2, vec3, vec4,
  select, clamp, min, max, mix, floor, mod, abs, sin, fract, dot, smoothstep,
  positionGeometry, screenCoordinate,
} from 'three/tsl';
import { makeTslSampler } from './tslSampler.js';
import { TS_MAX_SAMPLES } from './timeshiftEffect.js';

const makeSampler = () => makeTslSampler({ rgba: [0, 0, 0, 0] });

/** Same as GLSL `gl_FragCoord.xy / uResolution`. */
const frameUv = (u) => screenCoordinate.xy.div(u.uResolution);

const lumaOf = (c) => dot(c, vec3(0.2126, 0.7152, 0.0722));
const hash21 = (p) => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453123));

/** Straight colour out of a premultiplied sample. */
const straight = (c) => select(c.a.greaterThan(1e-4), c.rgb.div(max(c.a, 1e-4)), c.rgb);

function rangeMask(u, pm) {
  const c = straight(pm).toVar();
  const sft = max(u.uRSoft, 0.002).toVar();

  const l = lumaOf(c);
  const lumaM = smoothstep(sft.negate().add(u.uRLo), sft.add(u.uRLo), l)
    .mul(smoothstep(sft.negate().add(u.uRHi), sft.add(u.uRHi), l).oneMinus());

  const mx = max(c.r, max(c.g, c.b)).toVar();
  const mn = min(c.r, min(c.g, c.b)).toVar();
  const d = mx.sub(mn).toVar();
  const sat = select(mx.lessThanEqual(0.0), float(0.0), d.div(max(mx, 1e-5))).toVar();
  const h = float(0.0).toVar();
  If(d.greaterThan(1e-5), () => {
    const byR = mod(c.g.sub(c.b).div(d), 6.0);
    const byG = c.b.sub(c.r).div(d).add(2.0);
    const byB = c.r.sub(c.g).div(d).add(4.0);
    h.assign(select(mx.equal(c.r), byR, select(mx.equal(c.g), byG, byB)).mul(60.0));
    If(h.lessThan(0.0), () => { h.addAssign(360.0); });
  });
  const hd0 = abs(h.sub(u.uRHue)).toVar();
  const hd = min(hd0, float(360.0).sub(hd0));                  // hue is a circle
  const colourM = smoothstep(u.uRHueW, u.uRHueW.add(sft.mul(180.0)), hd).oneMinus()
    .mul(smoothstep(u.uRSat.sub(sft), u.uRSat.add(sft), sat));

  const m = select(u.uRange.lessThan(1.5), lumaM, colourM);
  const inverted = select(u.uRInvert.greaterThan(0.5), m.oneMinus(), m);
  return select(u.uRange.lessThan(0.5), float(1.0), inverted);
}

// Gain is applied to the EXPANDED value, never to c — see the GLSL twin.
const expand = (u, c) => c.div(max(float(1.0).sub(u.uHeadroom.mul(clamp(c, 0.0, 1.0))), 1e-3));
const compress = (u, e) => e.div(float(1.0).add(u.uHeadroom.mul(e)));

/** One ring slot out of the tile grid, with the half-texel inset. */
function atlasAt(u, uv, slot) {
  const s = mod(slot.add(u.uCap.mul(64.0)), u.uCap).toVar();
  const col = mod(s, u.uGrid.x);
  const row = floor(s.div(u.uGrid.x));
  const inset = vec2(0.5).div(u.uTilePx).toVar();
  const c = clamp(uv, inset, vec2(1.0).sub(inset));
  return u.uAtlas.sample(vec2(col, row).add(c).div(u.uGrid));
}

/**
 * Addressed in FRAMES BACK. The newest frame comes from the full-res plate
 * rather than its atlas tile — same image, more resolution.
 */
function ringAt(u, uv, back) {
  const maxb = max(u.uFilled.sub(1.0), 0.0).toVar();
  const b = clamp(back, 0.0, maxb).toVar();
  const f0 = floor(b).toVar();
  const fr = b.sub(f0).toVar();
  const plateUv = clamp(uv, 0.0, 1.0).toVar();
  const a = select(f0.lessThan(0.5), u.uPlate.sample(plateUv), atlasAt(u, uv, u.uHead.sub(f0))).toVar();
  const b1 = min(f0.add(1.0), maxb).toVar();
  const bb = select(b1.lessThan(0.5), u.uPlate.sample(plateUv), atlasAt(u, uv, u.uHead.sub(b1)));
  return select(fr.lessThanEqual(0.0), a, mix(a, bb, fr));
}

export function createTimeShiftRecordNodeMaterial() {
  const u = {
    uPlate: makeSampler(),
    uAtlasPx: uniform(new THREE.Vector2(2880, 1620)),
    uGrid: uniform(new THREE.Vector2(3, 3)),
    uSlot: uniform(0),
  };
  const material = new THREE.MeshBasicNodeMaterial();
  material.fragmentNode = Fn(() => {
    // Whole-atlas quad; fragments outside the target tile discard. The tile
    // mapping is the same expression the streak pass inverts, so any backend
    // difference in screenCoordinate's origin cancels between write and read.
    const atlasUv = screenCoordinate.xy.div(u.uAtlasPx).toVar();
    const cell = floor(atlasUv.mul(u.uGrid)).toVar();
    Discard(abs(cell.y.mul(u.uGrid.x).add(cell.x).sub(u.uSlot)).greaterThan(0.5));
    return u.uPlate.sample(clamp(fract(atlasUv.mul(u.uGrid)), 0.0, 1.0));
  })();
  material.vertexNode = vec4(positionGeometry.x, positionGeometry.y, 0.0, 1.0);
  material.transparent = false;
  material.blending = THREE.NoBlending;
  material.depthTest = false;
  material.depthWrite = false;
  material.forceSinglePass = true;
  material.uniforms = u;
  return material;
}

export function createTimeShiftStreakNodeMaterial() {
  const u = {
    uAtlas: makeSampler(),
    uPlate: makeSampler(),
    uResolution: uniform(new THREE.Vector2(1920, 1080)),
    uGrid: uniform(new THREE.Vector2(3, 3)),
    uTilePx: uniform(new THREE.Vector2(960, 540)),
    uHead: uniform(0),
    uFilled: uniform(0),
    uCap: uniform(8),
    uDir: uniform(new THREE.Vector2(0, 1)),
    uShift: uniform(0.3),
    uShutter: uniform(0.5),
    uTaps: uniform(24),
    uFall: uniform(0.5),
    uWrap: uniform(1),
    uGap: uniform(0),
    uGain: uniform(1),
    uHeadroom: uniform(0.97),
    uRange: uniform(0),
    uRLo: uniform(0.62),
    uRHi: uniform(1),
    uRSoft: uniform(0.12),
    uRHue: uniform(40),
    uRHueW: uniform(40),
    uRSat: uniform(0.25),
    uRInvert: uniform(0),
    uMix: uniform(1),
    uSeed: uniform(0),
  };

  const material = new THREE.MeshBasicNodeMaterial();
  material.fragmentNode = Fn(() => {
    const uvn = frameUv(u).toVar();
    const plate = u.uPlate.sample(uvn).toVar();

    const c0 = dot(uvn.sub(0.5), u.uDir).toVar();
    const perp = uvn.sub(0.5).sub(u.uDir.mul(c0)).toVar();

    const dith = hash21(screenCoordinate.xy.mul(0.7).add(u.uSeed))
      .sub(0.5).div(max(u.uTaps.sub(1.0), 1.0)).toVar();

    const acc = vec3(0.0).toVar();
    const accA = float(0.0).toVar();
    const wsum = float(0.0).toVar();

    Loop({ start: int(0), end: int(TS_MAX_SAMPLES) }, ({ i }) => {
      If(float(i).greaterThanEqual(u.uTaps), () => { Break(); });
      const un = select(
        u.uTaps.lessThanEqual(1.0),
        float(0.0),
        clamp(float(i).div(max(u.uTaps.sub(1.0), 1.0)).add(dith), 0.0, 1.0),
      ).toVar();

      const cc = c0.add(un.mul(u.uShift)).toVar();
      const k = select(u.uWrap.greaterThan(0.5), floor(cc.add(0.5)), float(0.0)).toVar();
      const cw = cc.sub(k).toVar();
      const pRaw = vec2(0.5).add(perp).add(u.uDir.mul(cw)).toVar();
      const p = select(u.uWrap.lessThan(0.5), clamp(pRaw, 0.0, 1.0), pRaw).toVar();

      const s = ringAt(u, p, un.mul(u.uShutter).add(abs(k))).toVar();

      // rgb only: the gate gap takes light away, not coverage.
      const gapK = float(1.0).sub(u.uGap.mul(smoothstep(float(0.5).sub(0.055), 0.5, abs(cw))));
      s.rgb.assign(select(u.uGap.greaterThan(0.0), s.rgb.mul(gapK), s.rgb));

      const w = mix(float(1.0), sin(float(3.14159265).mul(un)).add(0.08), u.uFall).toVar();
      const sel = rangeMask(u, s).toVar();
      acc.addAssign(expand(u, s.rgb).mul(w.mul(sel)));
      accA.addAssign(s.a.mul(w.mul(sel)));
      wsum.addAssign(w);
    });

    const inv = float(1.0).div(max(wsum, 1e-4)).toVar();
    acc.mulAssign(inv);
    accA.mulAssign(inv);

    // Whatever the range did not select never entered the streak, so it comes
    // back sharp. Zero when the range is off, so the chain is unchanged.
    const ks = rangeMask(u, plate).oneMinus().toVar();
    const keep = select(u.uRange.greaterThan(0.5), expand(u, plate.rgb).mul(ks), vec3(0.0)).toVar();
    const keepA = select(u.uRange.greaterThan(0.5), plate.a.mul(ks), float(0.0)).toVar();

    const outRgb = compress(u, acc.add(keep).mul(u.uGain)).toVar();
    const outA = clamp(accA.add(keepA), 0.0, 1.0).toVar();
    const outc = vec4(min(outRgb, vec3(outA)), outA);

    return mix(plate, outc, u.uMix);
  })();

  material.vertexNode = vec4(positionGeometry.x, positionGeometry.y, 0.0, 1.0);
  material.transparent = false;
  material.blending = THREE.NoBlending;
  material.depthTest = false;
  material.depthWrite = false;
  // ShaderMaterial's constructor sets this true; every NodeMaterial inherits
  // Material's false (PORTING-GUIDE §13).
  material.forceSinglePass = true;
  material.uniforms = u;
  return material;
}
