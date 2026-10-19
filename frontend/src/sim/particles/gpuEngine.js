// The LIVE engine — the particle solver on WebGPU, stepped in real time.
//
// The bake (solver.js) is the export truth: deterministic, sampled from a
// cache. This is the editor's preview of the same system: the fluid field and
// the particle integration run on the GPU every frame, so a slider moves the
// smoke NOW instead of after a re-bake. Emission stays on the CPU (the seeded
// random streams, the spawn table, the container test) and is the same code
// the bake runs — emission.js — so live and baked agree on where particles are
// born; what differs is who moves them.
//
// Contract with the renderer: `engine.sample(out, uids)` fills the same
// SAMPLE_STRIDE layout sampleParticles does, from the CPU mirror of the pool
// that every step reads back (one mapAsync per frame, ~1 ms for 20k).
//
// Contract with the governor (Q3): every advance measures its own wall time,
// per step, into `stats` — an EMA plus a run count of slow steps. There is no
// timer, no rAF hook and no polling: a layer that is not stepping costs nothing.
//
// A leaf module: no DOM, no three.js. navigator.gpu is touched only inside
// gpuParticleDevice(), so this file imports cleanly in node for the tests.

import { STEP_DT, SAMPLE_STRIDE, TTL_ALIVE } from './solver.js';
import { fluidGridDims, draftVec, PATH_N, resamplePath, SDF_W, SDF_H, gridInkMask } from './fluid.js';
import { collidersOf, particleRowsTotal } from './schema.js';
import { createEmission, fieldSplats, forceEmitterSetup, burstEnvelope, BURST_WINDOW } from './emission.js';
import { layerDriveOffset, layerDriveSplats } from './layerDrive.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** Steps per readback: a scrub fast-forwards in batches this long. */
export const BATCH_STEPS = 30;
/** Slow-step threshold and run length for the governor. */
export const SLOW_STEP_MS = 14;
export const SLOW_RUN = 30;
let slowStepMs = SLOW_STEP_MS;
/** Lower the threshold to force the fallback on a fast GPU (tests, debugging). */
export function setLiveSlowThreshold(ms) { slowStepMs = Number.isFinite(ms) && ms > 0 ? ms : SLOW_STEP_MS; }
/** Uniform block: 64 scalars, then vec4 blocks (16-aligned): vortex emitters
 *  ve0-2 at 64, blower emitters je0-2 (x, y, radius, strength) at 76, their
 *  push velocities jd0-2 at 88, the influence points inf0-2 (x, y, radius)
 *  at 100 — the local-coupling falloff centres — and the pulse forces
 *  be0-2 (x, y, radius, acceleration NOW) at 112, and the force emitters' mode
 *  and lift vm0-2 at 124, then the LAYER VELOCITY block: ldn (count, then the
 *  three strengths) at 136, ldg (the three "gradient on" flags) at 140, and one
 *  16-float slot per source at 144/160/176 — centre + radius, then the three
 *  rows of the velocity gradient with the centre's own velocity in their .w.
 *  That slot is layerDrive.js's LAYER_DRIVE_STRIDE, copied straight across. */
const U_FLOATS = 196;   // + `ret` (RETURN: x = 1 − e^(−k·dt)) at 192
const U_RET = 192;
const U_LD_N = 136, U_LD_G = 140, U_LD_0 = 144;
const U_BYTES = U_FLOATS * 4;
const MAX_SPLATS = 12;
const TURB_PATTERN = { smooth: 0, wave: 1, swirl: 2, billow: 3, ridged: 4 };
const VORT_MODE = { vortex: 0, orbit: 1, twist: 2, attract: 3, repel: 4 };
const VORT_AXIS = { x: 0, y: 1, z: 2 };
const RESTITUTION = 0.6;

// ── Capability ───────────────────────────────────────────────────────────────

/**
 * Whether this system can run live at all. Some features are bake-only by
 * design: Grow Points is a schedule over the artwork. Those fall back to the
 * cache — the governor is for speed, this is for shape.
 */
export function liveCapability(system, spawnTable = null) {
  const em = system.emitters?.[0];
  if (!em) return { ok: false, reason: 'no emitter' };
  const A = system.activation;
  if (A && A.mode === 'grow' && em.shape === 'layer' && spawnTable?.arrival?.length) return { ok: false, reason: 'Grow Points is bake-only' };
  /*
   * PACKING IS BAKE-ONLY. This engine has no neighbour query at all, so a
   * packing system would run here as if the block were off — and because this
   * is the LIVE PREVIEW path, the picture on screen would disagree with every
   * render. tier.js already refuses packing, but that guard is Tier 2's and does
   * not cover this engine; a system forced to Live preview reached it anyway.
   * Shape, not speed: it belongs here rather than in the governor.
   */
  if (system.packing?.enabled) return { ok: false, reason: 'Packing is bake-only' };
  /*
   * SEVERAL COLLIDERS ARE BAKE-ONLY. This engine has one `collMode` and one
   * collider binding — twenty-one references to a single collider — so a system
   * with more than one would run here honouring the first and ignoring the rest.
   * It is the LIVE PREVIEW, so that is a different picture from every render,
   * which is the exact failure the packing gate above was added for.
   */
  if (collidersOf(system).length > 1) return { ok: false, reason: 'Several colliders are baked' };
  /*
   * TRAILS ARE DRAWN FROM THE BAKE. A trail is a particle's own PAST, read from
   * the snapshot cache; this engine keeps the present only. Lines joined along a
   * rows grid need nothing but the present, so they stay live.
   */
  const R = system.render;
  if (R?.mode === 'lines' && !(R.lines?.connect === 'rows' && em.shape === 'rows')) {
    return { ok: false, reason: 'Trails are drawn from the bake' };
  }
  return { ok: true, reason: '' };
}

// ── Config (pure; mirrors bakeParticles' setup) ──────────────────────────────

export function engineConfig(system, duration, spawnTable = null, colliderTable = null, layerDrive = null) {
  const solver = system.solver;
  const em = system.emitters[0];
  const F = system.forces;
  // A rows emitter's pool is its grid, whatever maxParticles says.
  const maxP = particleRowsTotal(em) || Math.max(1, Math.round(solver.maxParticles));
  const preRoll = Math.max(0, solver.preRoll);
  const box = solver.bounds.size;
  const boundsMode = solver.bounds.behavior === 'wrap' ? 1 : solver.bounds.behavior === 'bounce' ? 2 : 0;
  const FL = F.fluid || { model: 'off' };
  const fluidOn = FL.model !== 'off';
  const smoke = FL.model === 'smoke';
  const dims = fluidOn ? fluidGridDims(FL.fidelity, box) : { nx: 1, ny: 1, nz: 1 };
  const C = system.collision;
  const collMode = colliderTable && C && C.source ? (C.faces === 'inner' ? 2 : 1) : 0;
  const toWorldPath = (anchors, size, origin) => resamplePath(anchors.map((a) => ({ x: origin.x + a.x * size.x, y: origin.y + a.y * size.y })));
  const emitPathS = em.shape === 'path' && em.path && em.path.anchors.length >= 2 ? toWorldPath(em.path.anchors, em.size, em.position) : null;
  const PF = system.pathFollow;
  const followS = PF && PF.enabled ? (PF.anchors && PF.anchors.length >= 2 ? toWorldPath(PF.anchors, box, { x: 0, y: 0 }) : emitPathS) : null;
  const staticEmit = em.emit === 'static' || em.shape === 'rows';
  const bursts = staticEmit
    ? [{ time: Math.max(0, em.start), count: maxP }]
    : (em.bursts || []).filter((b) => b.count > 0).map((b) => ({ time: b.time, count: b.count }));
  return {
    maxP, preRoll, duration: Math.max(0.1, duration), em, F, box, boundsMode, seed: system.seed | 0,
    FL, fluidOn, smoke, dims, n: dims.nx * dims.ny * dims.nz,
    h: { x: box.x / dims.nx, y: box.y / dims.ny, z: box.z / dims.nz },
    relax: fluidOn ? 1 - Math.exp(-FL.force * 0.03 * STEP_DT) : 0,
    collMode, collHalfD: collMode ? C.depth / 2 : 0, collBounce: collMode ? C.bounce : 0,
    emitPathS, followS, PF, staticEmit, bursts,
    turbOn: F.turbulence.strength > 0.01, vortOn: F.vortex.strength > 0.01,
    ...forceEmitterSetup(system, fluidOn),
    reachSources: fluidOn && FL.reach === 'sources' && (system.forceEmitters || []).length > 0 && (!!em.detach || em.shape === 'rows'),
    // RETURN: the per-step pull toward the birth point (solver.js). On, it needs
    // each particle's home on the GPU, which is a wider particle record — so the
    // record only widens while it is on (see `home` below).
    retK: F.return && F.return.strength > 0 ? 1 - Math.exp(-F.return.strength * STEP_DT) : 0,
    // Layer Velocity: the sampled track, indexed by step (see packUniforms).
    layerDrive: layerDrive && layerDrive.count > 0 ? layerDrive : null,
  };
}

/**
 * The LAYER VELOCITY block. The track is indexed by STEP, and the step is
 * derived from `t` rather than counted — `t = s·STEP_DT − preRoll` is the
 * bake's own definition (solver.js), so live and baked read the same row of the
 * same table instead of two counters that only agree until one of them resets.
 */
function packLayerDrives(F, cfg, t) {
  const LD = cfg.layerDrive;
  const drives = cfg.drivers || [];
  const n = LD ? Math.min(3, LD.count | 0, drives.length) : 0;
  F[U_LD_N] = n; F[U_LD_N + 1] = 0; F[U_LD_N + 2] = 0; F[U_LD_N + 3] = 0;
  F[U_LD_G] = 0; F[U_LD_G + 1] = 0; F[U_LD_G + 2] = 0; F[U_LD_G + 3] = 0;
  if (!n) return;
  const step = Math.round((t + cfg.preRoll) / STEP_DT);
  for (let k = 0; k < n; k++) {
    F[U_LD_N + 1 + k] = drives[k].strength;
    F[U_LD_G + k] = drives[k].spinDrag === false ? 0 : 1;
    const src = layerDriveOffset(LD, step, k), dst = U_LD_0 + k * 16;
    for (let i = 0; i < 16; i++) F[dst + i] = LD.data[src + i];
  }
}

/**
 * Pack the per-step uniforms. Pure, so the layout is testable in node: the
 * indices here are the struct in WGSL_U, in order.
 */
export function packUniforms(out, cfg, t, splatCount) {
  const F = out, I = new Uint32Array(out.buffer, out.byteOffset, out.length);
  packLayerDrives(F, cfg, t);
  const { dims, h, FL, F: forces } = cfg;
  const dtf = cfg.fluidOn ? STEP_DT * FL.timeFactor : STEP_DT;
  I[0] = dims.nx; I[1] = dims.ny; I[2] = dims.nz; I[3] = cfg.n;
  F[4] = h.x; F[5] = h.y; F[6] = h.z; F[7] = dtf;
  F[8] = STEP_DT; I[9] = cfg.smoke ? 1 : 0;
  F[10] = cfg.fluidOn && FL.swirl > 0.5 ? FL.swirl * 2.4 : 0;
  F[11] = cfg.smoke ? FL.smoke.buoyancy * 1.6 : 0;
  F[12] = cfg.smoke ? FL.smoke.weight * 1.6 : 0;
  F[13] = cfg.smoke ? 1 / (1 + FL.smoke.dissipate * dtf) : 1;
  F[14] = cfg.smoke ? 1 / (1 + FL.smoke.cooling * dtf) : 1;
  F[15] = cfg.fluidOn ? 1 / (1 + FL.fade * dtf) : 1;
  F[16] = cfg.fluidOn ? clamp(FL.viscosity * 0.02 * dtf * 60, 0, 0.92) : 0;
  F[17] = cfg.relax; I[18] = cfg.maxP; I[19] = cfg.followS ? 1 : 0;
  const PF = cfg.PF || {};
  F[20] = PF.attract || 0; F[21] = PF.flow || 0; F[22] = Math.max(1e-3, PF.proximity || 1); F[23] = PF.swirl > 0.5 ? PF.swirl : 0;
  I[24] = splatCount; F[25] = cfg.box.x; F[26] = cfg.box.y; F[27] = cfg.box.z;
  const [wx, wy] = cfg.fluidOn ? draftVec(forces.draft, t) : [0, 0];
  F[28] = wx; F[29] = wy; I[30] = cfg.fluidOn && FL.sharp ? 1 : 0; I[31] = cfg.fluidOn && FL.bounds === 'open' ? 1 : 0;
  I[32] = cfg.collMode; F[33] = cfg.collBounce; F[34] = cfg.collHalfD; I[35] = Math.max(1, Math.round(FL.swirlSize || 1));
  F[36] = forces.gravity.x + forces.wind.x; F[37] = forces.gravity.y + forces.wind.y; F[38] = forces.gravity.z + forces.wind.z; F[39] = forces.drag;
  const T = forces.turbulence;
  I[40] = cfg.turbOn ? 1 : 0; I[41] = TURB_PATTERN[T.pattern] || 0; F[42] = T.strength; F[43] = T.scale;
  F[44] = T.speed; F[45] = (T.direction || 0) * (Math.PI / 180); I[46] = Math.max(1, Math.min(6, Math.round(T.complexity || 3))); I[47] = (T.seedOffset || 5) >>> 0;
  const V = forces.vortex;
  F[48] = t; I[49] = cfg.vortOn ? 1 : 0; I[50] = VORT_MODE[V.mode] || 0; I[51] = VORT_AXIS[V.axis] ?? 1;
  F[52] = V.strength; F[53] = Math.max(1, V.scale); F[54] = V.lift ?? 0.5; I[55] = cfg.fluidOn && cfg.vortOn ? 1 : 0;
  I[56] = Math.min(3, cfg.vortices.length); I[57] = cfg.boundsMode; I[58] = cfg.fluidOn ? 1 : 0; I[59] = FL.pressureSteps || 0;
  const pushers = cfg.pushers || [];
  const infl = cfg.influences || [];
  I[60] = Math.min(3, pushers.length);
  const blasts = cfg.blasts || [];
  I[61] = cfg.reachSources ? 1 : 0; I[62] = Math.min(3, infl.length); I[63] = Math.min(3, blasts.length);
  for (let v = 0; v < 3; v++) {
    const o = 64 + v * 4;
    const mo = 124 + v * 4;
    if (v < cfg.vortices.length) {
      const fe = cfg.vortices[v];
      const p = cfg.fePos(fe, v, t);
      const mode = fe.mode || 'vortex';
      const rot = mode === 'vortex' || mode === 'orbit' || mode === 'twist';
      F[o] = p[0]; F[o + 1] = p[1]; F[o + 2] = Math.max(1, fe.radius);
      F[o + 3] = fe.strength * 1.2 * (rot && fe.spin === 'cw' ? -1 : 1);
      F[mo] = ['vortex', 'orbit', 'twist', 'attract', 'repel'].indexOf(mode); F[mo + 1] = fe.lift ?? 0.5; F[mo + 2] = 0; F[mo + 3] = 0;
    } else { F[o] = 0; F[o + 1] = 0; F[o + 2] = 1; F[o + 3] = 0; F[mo] = 0; F[mo + 1] = 0; F[mo + 2] = 0; F[mo + 3] = 0; }
    const j = 76 + v * 4, jd = 88 + v * 4;
    if (v < pushers.length) {
      const fe = pushers[v];
      const p = cfg.fePos(fe, v, t);
      const ang = (fe.direction || 0) * (Math.PI / 180);
      F[j] = p[0]; F[j + 1] = p[1]; F[j + 2] = Math.max(1, fe.radius); F[j + 3] = fe.strength;
      F[jd] = Math.cos(ang) * fe.push; F[jd + 1] = Math.sin(ang) * fe.push; F[jd + 2] = 0; F[jd + 3] = 0;
    } else { F[j] = 0; F[j + 1] = 0; F[j + 2] = 1; F[j + 3] = 0; F[jd] = 0; F[jd + 1] = 0; F[jd + 2] = 0; F[jd + 3] = 0; }
    const q = 100 + v * 4;
    if (v < infl.length) {
      const fe = infl[v];
      const p = cfg.fePos(fe, v, t);
      F[q] = p[0]; F[q + 1] = p[1]; F[q + 2] = Math.max(1, fe.radius); F[q + 3] = 1;
    } else { F[q] = 0; F[q + 1] = 0; F[q + 2] = 1; F[q + 3] = 0; }
    // Pulse forces: the envelope is a function of time, so it is resolved here
    // and the shader only ever sees "how hard, right now".
    const bq = 112 + v * 4;
    if (v < blasts.length) {
      const fe = blasts[v];
      const p = cfg.fePos(fe, v, t);
      const env = burstEnvelope(fe, t);
      F[bq] = p[0]; F[bq + 1] = p[1]; F[bq + 2] = Math.max(1, fe.radius);
      F[bq + 3] = env > 0 ? fe.push * env * (Math.PI / 2) / BURST_WINDOW : 0;
    } else { F[bq] = 0; F[bq + 1] = 0; F[bq + 2] = 1; F[bq + 3] = 0; }
  }
  F[U_RET] = cfg.retK || 0; F[U_RET + 1] = 0; F[U_RET + 2] = 0; F[U_RET + 3] = 0;
  return out;
}

// ── WGSL ─────────────────────────────────────────────────────────────────────
// No backticks anywhere inside: the shader is a JS template literal.

const WGSL_U = `struct U {
  nx:u32, ny:u32, nz:u32, n:u32,
  hx:f32, hy:f32, hz:f32, dtf:f32,
  dt:f32, smoke:u32, swirlEps:f32, buoy:f32,
  weight:f32, denK:f32, heatK:f32, fadeK:f32,
  viscA:f32, relax:f32, pcap:u32, follow:u32,
  pathAttract:f32, pathFlow:f32, pathProx:f32, pathSwirl:f32,
  splatCount:u32, boxx:f32, boxy:f32, boxz:f32,
  windX:f32, windY:f32, sharpAdv:u32, boundsOpen:u32,
  collMode:u32, collBounce:f32, collHalfD:f32, swirlR:u32,
  gx:f32, gy:f32, gz:f32, drag:f32,
  turbOn:u32, turbPat:u32, turbStr:f32, turbScale:f32,
  turbSpeed:f32, turbDir:f32, turbOct:u32, turbSeed:u32,
  t:f32, vortOn:u32, vortMode:u32, vortAxis:u32,
  vortStr:f32, vortScale:f32, vortLift:f32, fieldVort:u32,
  nVort:u32, boundsMode:u32, fluidOn:u32, pIters:u32,
  nJet:u32, reachSrc:u32, nInf:u32, nBlast:u32,
  ve0:vec4f, ve1:vec4f, ve2:vec4f,
  je0:vec4f, je1:vec4f, je2:vec4f,
  jd0:vec4f, jd1:vec4f, jd2:vec4f,
  inf0:vec4f, inf1:vec4f, inf2:vec4f,
  be0:vec4f, be1:vec4f, be2:vec4f,
  vm0:vec4f, vm1:vec4f, vm2:vec4f,
  ldn:vec4f, ldg:vec4f,
  ld0c:vec4f, ld0x:vec4f, ld0y:vec4f, ld0z:vec4f,
  ld1c:vec4f, ld1x:vec4f, ld1y:vec4f, ld1z:vec4f,
  ld2c:vec4f, ld2x:vec4f, ld2y:vec4f, ld2z:vec4f,
  ret:vec4f,
}`;

const WGSL = /* wgsl */`
${WGSL_U}
struct Part { pos: vec4f, vel: vec4f }

/* Nine storage buffers: the WebGPU default is 8, so the device is requested
   with the limit raised (see gpuParticleDevice). Divergence lives in aux.w. */
@group(0) @binding(0)  var<uniform> u: U;
@group(0) @binding(1)  var<storage, read_write> velSrc: array<vec4f>;
@group(0) @binding(2)  var<storage, read_write> velDst: array<vec4f>;
@group(0) @binding(3)  var<storage, read_write> heatSrc: array<f32>;
@group(0) @binding(4)  var<storage, read_write> heatDst: array<f32>;
@group(0) @binding(5)  var<storage, read_write> prsSrc: array<f32>;
@group(0) @binding(6)  var<storage, read_write> prsDst: array<f32>;
@group(0) @binding(7)  var<storage, read_write> aux: array<vec4f>;
@group(0) @binding(8)  var<storage, read_write> parts: array<Part>;
@group(0) @binding(9)  var<uniform> pathB: array<vec4f, ${PATH_N * 2}>;
@group(0) @binding(10) var<uniform> splatsU: array<vec4f, ${MAX_SPLATS * 3}>;
@group(0) @binding(11) var<storage, read_write> sdf: array<f32>;

/* 2D dispatch: rows of 256 groups, so a large grid never exceeds the 65535
   groups-per-dimension limit. */
fn gid1(g: vec3u) -> u32 { return g.x + g.y * 16384u; }

fn sdfS(x: f32, y: f32) -> f32 {
  let gx = clamp((x / u.boxx + 0.5) * ${SDF_W}.0 - 0.5, 0.0, ${SDF_W - 1}.0 - 0.001);
  let gy = clamp((0.5 - y / u.boxy) * ${SDF_H}.0 - 0.5, 0.0, ${SDF_H - 1}.0 - 0.001);
  let x0 = i32(floor(gx)); let y0 = i32(floor(gy));
  let fx = gx - floor(gx); let fy = gy - floor(gy);
  let o = x0 + y0 * ${SDF_W};
  return mix(mix(sdf[o], sdf[o + 1], fx), mix(sdf[o + ${SDF_W}], sdf[o + ${SDF_W + 1}], fx), fy);
}

fn cell(id: u32) -> vec3i {
  let i = i32(id % u.nx);
  let j = i32((id / u.nx) % u.ny);
  let k = i32(id / (u.nx * u.ny));
  return vec3i(i, j, k);
}
fn at(i: i32, j: i32, k: i32) -> u32 {
  let ci = u32(clamp(i, 0, i32(u.nx) - 1));
  let cj = u32(clamp(j, 0, i32(u.ny) - 1));
  let ck = u32(clamp(k, 0, i32(u.nz) - 1));
  return ci + u.nx * (cj + u.ny * ck);
}
fn cellWorld(c: vec3i) -> vec3f {
  return vec3f((f32(c.x) + 0.5) * u.hx - u.boxx * 0.5, (f32(c.y) + 0.5) * u.hy - u.boxy * 0.5, (f32(c.z) + 0.5) * u.hz - u.boxz * 0.5);
}
/* world px to continuous cell coords (centres at integers) */
fn wg(p: vec3f) -> vec3f {
  return vec3f((p.x + u.boxx * 0.5) / u.hx, (p.y + u.boxy * 0.5) / u.hy, (p.z + u.boxz * 0.5) / u.hz) - 0.5;
}
fn triV(g: vec3f) -> vec3f {
  let f = floor(g);
  let x0 = i32(f.x); let y0 = i32(f.y); let z0 = i32(f.z);
  let t = clamp(g - f, vec3f(0.0), vec3f(1.0));
  let c000 = velSrc[at(x0,y0,z0)].xyz;     let c100 = velSrc[at(x0+1,y0,z0)].xyz;
  let c010 = velSrc[at(x0,y0+1,z0)].xyz;   let c110 = velSrc[at(x0+1,y0+1,z0)].xyz;
  let c001 = velSrc[at(x0,y0,z0+1)].xyz;   let c101 = velSrc[at(x0+1,y0,z0+1)].xyz;
  let c011 = velSrc[at(x0,y0+1,z0+1)].xyz; let c111 = velSrc[at(x0+1,y0+1,z0+1)].xyz;
  return mix(mix(mix(c000,c100,t.x), mix(c010,c110,t.x), t.y), mix(mix(c001,c101,t.x), mix(c011,c111,t.x), t.y), t.z);
}
fn triW(g: vec3f) -> f32 {
  let f = floor(g);
  let x0 = i32(f.x); let y0 = i32(f.y); let z0 = i32(f.z);
  let t = clamp(g - f, vec3f(0.0), vec3f(1.0));
  let c00 = mix(velSrc[at(x0,y0,z0)].w, velSrc[at(x0+1,y0,z0)].w, t.x);
  let c10 = mix(velSrc[at(x0,y0+1,z0)].w, velSrc[at(x0+1,y0+1,z0)].w, t.x);
  let c01 = mix(velSrc[at(x0,y0,z0+1)].w, velSrc[at(x0+1,y0,z0+1)].w, t.x);
  let c11 = mix(velSrc[at(x0,y0+1,z0+1)].w, velSrc[at(x0+1,y0+1,z0+1)].w, t.x);
  return mix(mix(c00, c10, t.y), mix(c01, c11, t.y), t.z);
}
fn triH(g: vec3f) -> f32 {
  let f = floor(g);
  let x0 = i32(f.x); let y0 = i32(f.y); let z0 = i32(f.z);
  let t = clamp(g - f, vec3f(0.0), vec3f(1.0));
  let c00 = mix(heatSrc[at(x0,y0,z0)], heatSrc[at(x0+1,y0,z0)], t.x);
  let c10 = mix(heatSrc[at(x0,y0+1,z0)], heatSrc[at(x0+1,y0+1,z0)], t.x);
  let c01 = mix(heatSrc[at(x0,y0,z0+1)], heatSrc[at(x0+1,y0,z0+1)], t.x);
  let c11 = mix(heatSrc[at(x0,y0+1,z0+1)], heatSrc[at(x0+1,y0+1,z0+1)], t.x);
  return mix(mix(c00, c10, t.y), mix(c01, c11, t.y), t.z);
}

/* ── the solver's own forces, ported from fields.js / fluid.js ── */

/* fieldAccel: radial/tangential field about one box axis, five modes */
fn fieldAccel(p: vec3f) -> vec3f {
  var ax: f32; var ay: f32;
  if (u.vortAxis == 0u) { ax = p.y; ay = p.z; }
  else if (u.vortAxis == 2u) { ax = p.x; ay = p.y; }
  else { ax = p.x; ay = p.z; }
  let r0 = length(vec2f(ax, ay));
  let r = select(r0, 1e-3, r0 == 0.0);
  let k = r / u.vortScale;
  let fall = 1.0 / (1.0 + k * k);
  let s = u.vortStr * fall;
  let rx = ax / r; let ry = ay / r;
  let tx = -ry; let ty = rx;
  var a = 0.0; var b = 0.0; var w = 0.0;
  if (u.vortMode == 3u) { a = -rx * s; b = -ry * s; }
  else if (u.vortMode == 4u) { a = rx * s; b = ry * s; }
  else if (u.vortMode == 1u) { a = tx * s; b = ty * s; }
  else if (u.vortMode == 2u) { a = tx * s; b = ty * s; w = s * u.vortLift * fall; }
  else { a = tx * s - rx * s * 0.18; b = ty * s - ry * s * 0.18; }
  if (u.vortAxis == 0u) { return vec3f(w, a, b); }
  if (u.vortAxis == 2u) { return vec3f(a, b, w); }
  return vec3f(a, w, b);
}

/* vortexPointAccel: a vortex emitter, rigid-core rotation with inward bias */
fn vortexPoint(ve: vec4f, p: vec2f) -> vec2f {
  let d = p - ve.xy;
  let r = length(d) + 1e-4;
  let q = r / ve.z;
  let fall = q * exp(1.0 - q * q);
  let rd = d / r;
  let amp = ve.w;
  return vec2f(-rd.y * amp - rd.x * abs(amp) * 0.15, rd.x * amp - rd.y * abs(amp) * 0.15) * fall;
}
/* A pulse force: outward from its point, gaussian falloff, amplitude already
   carrying this instant's envelope (0 between impulses). */
fn blastPoint(be: vec4f, p: vec2f) -> vec2f {
  if (be.w == 0.0) { return vec2f(0.0); }
  let d = p - be.xy;
  let dist = length(d) + 1e-4;
  let q = dist / be.z;
  return (d / dist) * (be.w * exp(-q * q));
}
fn blastEmitters(p: vec2f) -> vec2f {
  var a = vec2f(0.0);
  if (u.nBlast > 0u) { a += blastPoint(u.be0, p); }
  if (u.nBlast > 1u) { a += blastPoint(u.be1, p); }
  if (u.nBlast > 2u) { a += blastPoint(u.be2, p); }
  return a;
}
/* A force emitter in any of GLOBAL FORCE's shapes, centred on itself. Mode 0
   (vortex) keeps the rigid-core profile; the rest mirror fieldAccel's
   1/(1+k²) falloff about the emitter's own radius. z carries twist's lift. */
fn forcePoint(ve: vec4f, vm: vec4f, p: vec2f) -> vec3f {
  let mode = u32(vm.x + 0.5);
  if (mode == 0u) { return vec3f(vortexPoint(ve, p), 0.0); }
  let d = p - ve.xy;
  let r = length(d) + 1e-4;
  let k = r / max(1.0, ve.z);
  let fall = 1.0 / (1.0 + k * k);
  let s = ve.w * fall;
  let rd = d / r;
  let td = vec2f(-rd.y, rd.x);
  if (mode == 1u) { return vec3f(td * s, 0.0); }                       // orbit
  if (mode == 2u) { return vec3f(td * s, s * vm.y * fall); }           // twist
  if (mode == 3u) { return vec3f(-rd * s, 0.0); }                      // attract
  return vec3f(rd * s, 0.0);                                           // repel
}
fn vortexEmitters(p: vec2f) -> vec3f {
  var a = vec3f(0.0);
  if (u.nVort > 0u) { a += forcePoint(u.ve0, u.vm0, p); }
  if (u.nVort > 1u) { a += forcePoint(u.ve1, u.vm1, p); }
  if (u.nVort > 2u) { a += forcePoint(u.ve2, u.vm2, p); }
  return a;
}
/* jetPointPush: a blower on a particle, the no-field case — blend toward its
   push velocity inside its radius, the way its splat blends the field */
fn jetPush(je: vec4f, jd: vec4f, p: vec2f, vel: vec2f) -> vec2f {
  let d = (p - je.xy) / je.z;
  let w = exp(-dot(d, d));
  if (w < 1e-3) { return vel; }
  let a = clamp(je.w / 100.0 * w * u.dt * 10.0, 0.0, 1.0);
  return vel + (jd.xy - vel) * a;
}
/* Local coupling: how strongly the flow grips a particle here — a gaussian
   around each force emitter, the same shape its splat deposits with. Whole-box
   coupling is reachSrc == 0, where this is not called at all. */
fn influenceAt(p: vec2f) -> f32 {
  var w = 0.0;
  if (u.nInf > 0u) { let d = (p - u.inf0.xy) / u.inf0.z; w = max(w, exp(-dot(d, d))); }
  if (u.nInf > 1u) { let d = (p - u.inf1.xy) / u.inf1.z; w = max(w, exp(-dot(d, d))); }
  if (u.nInf > 2u) { let d = (p - u.inf2.xy) / u.inf2.z; w = max(w, exp(-dot(d, d))); }
  return w;
}
/* LAYER VELOCITY: one moving layer's own animation as a force. Argument c is
   its centre and reach, and the rows carry the velocity gradient with the centre's
   velocity in .w — so v(p) = A*(p-c) + b, the exact 3D field of a rigid body
   that is also allowed to scale. Ports applyLayerDrives in layerDrive.js. */
fn layerDrive(c: vec4f, rx: vec4f, ry: vec4f, rz: vec4f, strength: f32, grad: f32, p: vec3f, vel: vec3f) -> vec3f {
  if (strength <= 0.0) { return vel; }
  let d = p - c.xyz;
  let r = max(c.w, 1.0);
  let q = dot(d, d) / (r * r);
  if (q > 12.0) { return vel; }
  let w = exp(-q);
  if (w < 1e-3) { return vel; }
  let b = vec3f(rx.w, ry.w, rz.w);
  var tv = b;
  if (grad > 0.5) { tv = vec3f(dot(rx.xyz, d), dot(ry.xyz, d), dot(rz.xyz, d)) + b; }
  let a = clamp(strength / 100.0 * w * u.dt * 10.0, 0.0, 1.0);
  return vel + (tv - vel) * a;
}
fn layerDrives(p: vec3f, vel: vec3f) -> vec3f {
  var v = vel;
  let n = u.ldn.x;
  if (n > 0.5) { v = layerDrive(u.ld0c, u.ld0x, u.ld0y, u.ld0z, u.ldn.y, u.ldg.x, p, v); }
  if (n > 1.5) { v = layerDrive(u.ld1c, u.ld1x, u.ld1y, u.ld1z, u.ldn.z, u.ldg.y, p, v); }
  if (n > 2.5) { v = layerDrive(u.ld2c, u.ld2x, u.ld2y, u.ld2z, u.ldn.w, u.ldg.z, p, v); }
  return v;
}
fn jetEmitters(p: vec2f, vel: vec2f) -> vec2f {
  var v = vel;
  if (u.nJet > 0u) { v = jetPush(u.je0, u.jd0, p, v); }
  if (u.nJet > 1u) { v = jetPush(u.je1, u.jd1, p, v); }
  if (u.nJet > 2u) { v = jetPush(u.je2, u.jd2, p, v); }
  return v;
}

/* turbulence: the same closed forms as fields.js (sines, wave, value-noise fbm) */
fn ihash3(x: i32, y: i32, z: i32, s: u32) -> f32 {
  var h = u32(x) * 374761393u + u32(y) * 668265263u + u32(z) * 2147483647u + s * 974711369u;
  h = (h ^ (h >> 13u)) * 1274126177u;
  return f32(h ^ (h >> 16u)) * (1.0 / 4294967296.0);
}
fn vnoise3(p: vec3f, s: u32) -> f32 {
  let pi = floor(p);
  var f = p - pi;
  f = f * f * (3.0 - 2.0 * f);
  let xi = i32(pi.x); let yi = i32(pi.y); let zi = i32(pi.z);
  let c000 = ihash3(xi, yi, zi, s);     let c100 = ihash3(xi+1, yi, zi, s);
  let c010 = ihash3(xi, yi+1, zi, s);   let c110 = ihash3(xi+1, yi+1, zi, s);
  let c001 = ihash3(xi, yi, zi+1, s);   let c101 = ihash3(xi+1, yi, zi+1, s);
  let c011 = ihash3(xi, yi+1, zi+1, s); let c111 = ihash3(xi+1, yi+1, zi+1, s);
  return mix(mix(mix(c000,c100,f.x), mix(c010,c110,f.x), f.y), mix(mix(c001,c101,f.x), mix(c011,c111,f.x), f.y), f.z);
}
fn fbm3(p0: vec3f, s: u32, oct: u32, shape: u32) -> f32 {
  var p = p0; var v = 0.0; var amp = 0.5; var norm = 0.0;
  for (var i = 0u; i < oct; i++) {
    var n = vnoise3(p, s + i * 17u);
    if (shape == 1u) { n = abs(n * 2.0 - 1.0); }
    else if (shape == 2u) { n = 1.0 - abs(n * 2.0 - 1.0); }
    v += n * amp; norm += amp;
    p = p * 2.03 + vec3f(7.1, -3.7, 1.9);
    amp *= 0.5;
  }
  return v / max(norm, 1e-4);
}
fn turbulence(p: vec3f, phase: f32) -> vec3f {
  let sc = u.turbScale;
  let evo = u.t * u.turbSpeed;
  if (u.turbPat == 0u) {
    return vec3f(
      sin(p.y * sc * 1.3 + evo * 1.10 + phase) - sin(p.z * sc * 0.9 - evo * 0.70 + phase * 0.7),
      sin(p.z * sc * 1.1 - evo * 0.90 + phase) - sin(p.x * sc * 1.2 + evo * 1.30 + phase * 1.3),
      sin(p.x * sc * 0.8 + evo * 0.80 + phase) - sin(p.y * sc * 1.4 - evo * 1.20 + phase * 0.4));
  }
  if (u.turbPat == 1u) {
    let dx = cos(u.turbDir); let dy = sin(u.turbDir);
    let ph = (p.x * dx + p.y * dy) * sc * 6.0 - evo * 3.0 + phase * 0.15;
    let s = sin(ph);
    return vec3f(-dy * s * 2.24, dx * s * 2.24, sin(ph * 0.6 + p.z * sc * 3.0) * 0.45 * 2.24);
  }
  let q = p * (sc * 1.6) + vec3f(0.0, 0.0, evo * 0.35);
  if (u.turbPat == 2u) {
    let e = 0.55; let g = 1.33 * 3.2; let oct = u.turbOct; let sd = u.turbSeed;
    let nyp = fbm3(q + vec3f(0.0, e, 0.0), sd, oct, 0u); let nym = fbm3(q - vec3f(0.0, e, 0.0), sd, oct, 0u);
    let nzp = fbm3(q + vec3f(0.0, 0.0, e), sd, oct, 0u); let nzm = fbm3(q - vec3f(0.0, 0.0, e), sd, oct, 0u);
    let nxp = fbm3(q + vec3f(e, 0.0, 0.0), sd, oct, 0u); let nxm = fbm3(q - vec3f(e, 0.0, 0.0), sd, oct, 0u);
    return vec3f(((nyp - nym) - (nzp - nzm)) * g, ((nzp - nzm) - (nxp - nxm)) * g, ((nxp - nxm) - (nyp - nym)) * g);
  }
  let shape = select(1u, 2u, u.turbPat == 4u);
  let g = 2.03; let oct = u.turbOct; let sd = u.turbSeed;
  return vec3f(
    (fbm3(q, sd, oct, shape) * 2.0 - 1.0) * g,
    (fbm3(q + vec3f(41.7, -17.3, 0.0), sd + 91u, oct, shape) * 2.0 - 1.0) * g,
    (fbm3(q + vec3f(-23.1, 63.9, 0.0), sd + 173u, oct, shape) * 2.0 - 1.0) * g);
}

/* ── field passes ── */

@compute @workgroup_size(64) fn splat_pass(@builtin(global_invocation_id) gid: vec3u) {
  let id = gid1(gid); if (id >= u.n) { return; }
  let wp = cellWorld(cell(id));
  var v = velSrc[id];
  var h = heatSrc[id];
  for (var s = 0u; s < u.splatCount; s++) {
    let posr = splatsU[s * 3u];
    let velk = splatsU[s * 3u + 1u];
    let dh = splatsU[s * 3u + 2u];
    let d = (wp - posr.xyz) / posr.w;
    let w = exp(-dot(d, d));
    if (w < 1e-3) { continue; }
    let a = clamp(velk.w * w * u.dtf * 10.0, 0.0, 1.0);
    v = vec4f(v.xyz + (velk.xyz - v.xyz) * a, min(2.0, v.w + dh.x * w * u.dtf));
    h = min(2.0, h + dh.y * w * u.dtf);
  }
  velSrc[id] = v;
  heatSrc[id] = h;
}

@compute @workgroup_size(64) fn curl_pass(@builtin(global_invocation_id) gid: vec3u) {
  let id = gid1(gid); if (id >= u.n) { return; }
  let c = cell(id);
  let wx = (velSrc[at(c.x,c.y+1,c.z)].z - velSrc[at(c.x,c.y-1,c.z)].z) / (2.0*u.hy) - (velSrc[at(c.x,c.y,c.z+1)].y - velSrc[at(c.x,c.y,c.z-1)].y) / (2.0*u.hz);
  let wy = (velSrc[at(c.x,c.y,c.z+1)].x - velSrc[at(c.x,c.y,c.z-1)].x) / (2.0*u.hz) - (velSrc[at(c.x+1,c.y,c.z)].z - velSrc[at(c.x-1,c.y,c.z)].z) / (2.0*u.hx);
  let wz = (velSrc[at(c.x+1,c.y,c.z)].y - velSrc[at(c.x-1,c.y,c.z)].y) / (2.0*u.hx) - (velSrc[at(c.x,c.y+1,c.z)].x - velSrc[at(c.x,c.y-1,c.z)].x) / (2.0*u.hy);
  aux[id] = vec4f(wx, wy, wz, length(vec3f(wx, wy, wz)));
}

@compute @workgroup_size(64) fn forces_pass(@builtin(global_invocation_id) gid: vec3u) {
  let id = gid1(gid); if (id >= u.n) { return; }
  let c = cell(id);
  let wp = cellWorld(c);
  var v = velSrc[id];
  if (u.smoke == 1u) {
    v.y += (u.buoy * heatSrc[id] - u.weight * v.w) * u.dtf;
  }
  /* draft: a gusting wind, uniform in space (computed per step from time) */
  if (abs(u.windX) + abs(u.windY) > 0.0) {
    v = vec4f(v.x + u.windX * u.dtf, v.y + u.windY * u.dtf, v.z, v.w);
  }
  /* point forces on the FIELD: the solver vortex and the vortex emitters */
  if (u.fieldVort == 1u) {
    let a = fieldAccel(wp);
    v = vec4f(v.xyz + a * u.dtf, v.w);
  }
  if (u.nVort > 0u) {
    let a2 = vortexEmitters(wp.xy);
    v = vec4f(v.x + a2.x * u.dtf, v.y + a2.y * u.dtf, v.z + a2.z * u.dtf, v.w);
  }
  if (u.nBlast > 0u) {
    let a3 = blastEmitters(wp.xy);
    v = vec4f(v.x + a3.x * u.dtf, v.y + a3.y * u.dtf, v.z, v.w);
  }
  if (u.swirlEps > 0.0) {
    let R = i32(u.swirlR);
    var n = vec3f(
      (aux[at(c.x+R,c.y,c.z)].w - aux[at(c.x-R,c.y,c.z)].w) / (2.0*u.hx*f32(R)),
      (aux[at(c.x,c.y+R,c.z)].w - aux[at(c.x,c.y-R,c.z)].w) / (2.0*u.hy*f32(R)),
      (aux[at(c.x,c.y,c.z+R)].w - aux[at(c.x,c.y,c.z-R)].w) / (2.0*u.hz*f32(R)));
    n = n / (length(n) + 1e-5);
    v = vec4f(v.xyz + u.swirlEps * cross(n, aux[id].xyz) * u.dtf, v.w);
  }
  velSrc[id] = v;
}

@compute @workgroup_size(64) fn advect_pass(@builtin(global_invocation_id) gid: vec3u) {
  let id = gid1(gid); if (id >= u.n) { return; }
  let c = cell(id);
  let v = velSrc[id];
  let g = vec3f(f32(c.x), f32(c.y), f32(c.z)) - v.xyz * u.dtf / vec3f(u.hx, u.hy, u.hz);
  var nd = 0.0; var nh = 0.0;
  if (u.smoke == 1u) { nd = triW(g) * u.denK; nh = triH(g) * u.heatK; }
  else { nd = velSrc[id].w; nh = heatSrc[id]; }
  let vcap = 2.5 * vec3f(u.hx, u.hy, u.hz) / u.dtf;
  velDst[id] = vec4f(clamp(triV(g) * u.fadeK, -vcap, vcap), nd);
  heatDst[id] = nh;
}

@compute @workgroup_size(64) fn mac_bwd(@builtin(global_invocation_id) gid: vec3u) {
  let id = gid1(gid); if (id >= u.n) { return; }
  let c = cell(id);
  let v0 = velSrc[id].xyz;
  let g = vec3f(f32(c.x), f32(c.y), f32(c.z)) + v0 * u.dtf / vec3f(u.hx, u.hy, u.hz);
  let f = floor(g);
  let x0 = i32(f.x); let y0 = i32(f.y); let z0 = i32(f.z);
  let t = clamp(g - f, vec3f(0.0), vec3f(1.0));
  let c000 = velDst[at(x0,y0,z0)].xyz;     let c100 = velDst[at(x0+1,y0,z0)].xyz;
  let c010 = velDst[at(x0,y0+1,z0)].xyz;   let c110 = velDst[at(x0+1,y0+1,z0)].xyz;
  let c001 = velDst[at(x0,y0,z0+1)].xyz;   let c101 = velDst[at(x0+1,y0,z0+1)].xyz;
  let c011 = velDst[at(x0,y0+1,z0+1)].xyz; let c111 = velDst[at(x0+1,y0+1,z0+1)].xyz;
  let bwd = mix(mix(mix(c000,c100,t.x), mix(c010,c110,t.x), t.y), mix(mix(c001,c101,t.x), mix(c011,c111,t.x), t.y), t.z);
  aux[id] = vec4f(bwd, 0.0);
}

@compute @workgroup_size(64) fn mac_correct(@builtin(global_invocation_id) gid: vec3u) {
  let id = gid1(gid); if (id >= u.n) { return; }
  let c = cell(id);
  let v0 = velSrc[id].xyz;
  let g = vec3f(f32(c.x), f32(c.y), f32(c.z)) - v0 * u.dtf / vec3f(u.hx, u.hy, u.hz);
  let f = floor(g);
  let x0 = i32(f.x); let y0 = i32(f.y); let z0 = i32(f.z);
  let c000 = velSrc[at(x0,y0,z0)].xyz;     let c100 = velSrc[at(x0+1,y0,z0)].xyz;
  let c010 = velSrc[at(x0,y0+1,z0)].xyz;   let c110 = velSrc[at(x0+1,y0+1,z0)].xyz;
  let c001 = velSrc[at(x0,y0,z0+1)].xyz;   let c101 = velSrc[at(x0+1,y0,z0+1)].xyz;
  let c011 = velSrc[at(x0,y0+1,z0+1)].xyz; let c111 = velSrc[at(x0+1,y0+1,z0+1)].xyz;
  let mn = min(min(min(c000,c100), min(c010,c110)), min(min(c001,c101), min(c011,c111)));
  let mx = max(max(max(c000,c100), max(c010,c110)), max(max(c001,c101), max(c011,c111)));
  let d = velDst[id];
  let val = clamp(d.xyz + 0.5 * (v0 - aux[id].xyz), mn, mx);
  velDst[id] = vec4f(val, d.w);
}

@compute @workgroup_size(64) fn diffuse_pass(@builtin(global_invocation_id) gid: vec3u) {
  let id = gid1(gid); if (id >= u.n) { return; }
  let c = cell(id);
  let avg = (velSrc[at(c.x-1,c.y,c.z)].xyz + velSrc[at(c.x+1,c.y,c.z)].xyz
           + velSrc[at(c.x,c.y-1,c.z)].xyz + velSrc[at(c.x,c.y+1,c.z)].xyz
           + velSrc[at(c.x,c.y,c.z-1)].xyz + velSrc[at(c.x,c.y,c.z+1)].xyz) / 6.0;
  let s = velSrc[id];
  velDst[id] = vec4f(mix(s.xyz, avg, u.viscA * 0.5), s.w);
  heatDst[id] = heatSrc[id];
}

@compute @workgroup_size(64) fn div_pass(@builtin(global_invocation_id) gid: vec3u) {
  let id = gid1(gid); if (id >= u.n) { return; }
  let c = cell(id);
  let d = (velSrc[at(c.x+1,c.y,c.z)].x - velSrc[at(c.x-1,c.y,c.z)].x) / (2.0*u.hx)
        + (velSrc[at(c.x,c.y+1,c.z)].y - velSrc[at(c.x,c.y-1,c.z)].y) / (2.0*u.hy)
        + (velSrc[at(c.x,c.y,c.z+1)].z - velSrc[at(c.x,c.y,c.z-1)].z) / (2.0*u.hz);
  aux[id] = vec4f(0.0, 0.0, 0.0, d);
  prsSrc[id] = 0.0;
  prsDst[id] = 0.0;
}

/* closed: clamped read = Neumann. open: zero outside = Dirichlet outflow */
fn pAt(i: i32, j: i32, k: i32) -> f32 {
  if (u.boundsOpen == 1u && (i < 0 || j < 0 || k < 0 || i >= i32(u.nx) || j >= i32(u.ny) || k >= i32(u.nz))) { return 0.0; }
  return prsSrc[at(i, j, k)];
}

@compute @workgroup_size(64) fn jacobi_pass(@builtin(global_invocation_id) gid: vec3u) {
  let id = gid1(gid); if (id >= u.n) { return; }
  let c = cell(id);
  let cx = 1.0 / (u.hx * u.hx); let cy = 1.0 / (u.hy * u.hy); let cz = 1.0 / (u.hz * u.hz);
  prsDst[id] = (cx * (pAt(c.x-1,c.y,c.z) + pAt(c.x+1,c.y,c.z))
              + cy * (pAt(c.x,c.y-1,c.z) + pAt(c.x,c.y+1,c.z))
              + cz * (pAt(c.x,c.y,c.z-1) + pAt(c.x,c.y,c.z+1))
              - aux[id].w) / (2.0 * (cx + cy + cz));
}

@compute @workgroup_size(64) fn project_pass(@builtin(global_invocation_id) gid: vec3u) {
  let id = gid1(gid); if (id >= u.n) { return; }
  let c = cell(id);
  var v = velSrc[id];
  v.x -= (pAt(c.x+1,c.y,c.z) - pAt(c.x-1,c.y,c.z)) / (2.0*u.hx);
  v.y -= (pAt(c.x,c.y+1,c.z) - pAt(c.x,c.y-1,c.z)) / (2.0*u.hy);
  v.z -= (pAt(c.x,c.y,c.z+1) - pAt(c.x,c.y,c.z-1)) / (2.0*u.hz);
  if (u.boundsOpen == 0u) {
    if (c.x == 0 || c.x == i32(u.nx) - 1) { v.x = 0.0; }
    if (c.y == 0 || c.y == i32(u.ny) - 1) { v.y = 0.0; }
    if (c.z == 0 || c.z == i32(u.nz) - 1) { v.z = 0.0; }
  } else {
    let dEdge = min(min(min(c.x, i32(u.nx) - 1 - c.x), min(c.y, i32(u.ny) - 1 - c.y)), min(c.z, i32(u.nz) - 1 - c.z));
    if (dEdge < 3) { v = vec4f(v.xyz * (0.75 + 0.25 * f32(dEdge) / 3.0), v.w); }
  }
  if (u.collMode != 0u) {
    let wp = cellWorld(c);
    let inside3 = sdfS(wp.x, wp.y) < 0.0 && abs(wp.z) < u.collHalfD;
    let solid = select(!inside3, inside3, u.collMode == 1u);
    if (solid) { v = vec4f(v.xyz * 0.05, v.w); }
  }
  velSrc[id] = v;
}

/* ── the particles ── pos.w holds the uid (0 = dead), vel.w the path cache */
@compute @workgroup_size(64) fn particle_pass(@builtin(global_invocation_id) gid: vec3u) {
  let id = gid1(gid); if (id >= u.pcap) { return; }
  var p = parts[id];
  if (p.pos.w < 0.5) { return; }
  var pos = p.pos.xyz;
  var vel = p.vel.xyz;
  let uidF = p.pos.w;
  vel += vec3f(u.gx, u.gy, u.gz) * u.dt;
  if (u.turbOn == 1u) {
    let phase = f32(u32(uidF + 0.5) % 97u) * 0.41;
    vel += turbulence(pos, phase) * u.turbStr * u.dt;
  }
  if (u.vortOn == 1u) { vel += fieldAccel(pos) * u.dt; }
  if (u.nBlast > 0u) {
    let ab = blastEmitters(pos.xy);
    vel = vec3f(vel.x + ab.x * u.dt, vel.y + ab.y * u.dt, vel.z);
  }
  if (u.drag > 0.0) { vel *= max(0.0, 1.0 - u.drag * u.dt); }
  if (u.fluidOn == 1u) {
    let fv = triV(wg(pos));
    var rl = u.relax;
    if (u.reachSrc == 1u) { rl = rl * influenceAt(pos.xy); }
    vel += (fv - vel) * rl;
  } else {
    if (u.nVort > 0u) {
      vel += vortexEmitters(pos.xy) * u.dt;
    }
    if (u.nJet > 0u) {
      let v2 = jetEmitters(pos.xy, vel.xy);
      vel = vec3f(v2, vel.z);
    }
  }
  /* After the field, so near a moving layer the LAYER wins: it is the thing
     displacing the medium there, and letting the field's own (one step stale)
     velocity override it makes the drag lag visibly behind. */
  if (u.ldn.x > 0.5) { vel = layerDrives(pos, vel); }
  var nearI = i32(p.vel.w);
  if (u.follow == 1u) {
    if (nearI < 0) {
      var bd0 = 1e30;
      for (var s = 0u; s < u32(${PATH_N}); s += 8u) {
        let d = pathB[s * 2u].xyz - pos;
        let dd = dot(d, d);
        if (dd < bd0) { bd0 = dd; nearI = i32(s); }
      }
    }
    var bd = 1e30;
    { let d = pathB[u32(nearI) * 2u].xyz - pos; bd = dot(d, d); }
    for (var it = 0; it < 24; it++) {
      var moved = false;
      if (nearI > 0) {
        let d = pathB[u32(nearI - 1) * 2u].xyz - pos;
        if (dot(d, d) < bd) { nearI -= 1; bd = dot(d, d); moved = true; }
      }
      if (!moved && nearI < ${PATH_N - 1}) {
        let d = pathB[u32(nearI + 1) * 2u].xyz - pos;
        if (dot(d, d) < bd) { nearI += 1; bd = dot(d, d); moved = true; }
      }
      if (!moved) { break; }
    }
    let q = pathB[u32(nearI) * 2u].xyz;
    let T = pathB[u32(nearI) * 2u + 1u].xyz;
    let toQ = q - pos;
    let d = length(toQ) + 1e-5;
    let qq = d / u.pathProx;
    let fall = 1.0 / (1.0 + qq * qq);
    vel += (toQ / d) * u.pathAttract * 3.0 * fall * u.dt;
    vel += T * u.pathFlow * 3.0 * fall * u.dt;
    if (u.pathSwirl > 0.0) {
      vel += cross(T, -toQ / d) * u.pathSwirl * 3.0 * fall * u.dt;
    }
  }
  pos += vel * u.dt;
  let hx = u.boxx * 0.5; let hy = u.boxy * 0.5; let hz = u.boxz * 0.5;
  if (u.collMode != 0u) {
    let s2 = sdfS(pos.x, pos.y);
    let zd = abs(pos.z) - u.collHalfD;
    let useZ = zd > s2;
    let sd = max(s2, zd);
    let viol = select(sd > -6.0, sd < 6.0, u.collMode == 1u);
    if (viol) {
      var n3: vec3f;
      if (useZ) {
        n3 = vec3f(0.0, 0.0, select(-1.0, 1.0, pos.z >= 0.0));
      } else {
        var n2 = vec2f((sdfS(pos.x + 6.0, pos.y) - sdfS(pos.x - 6.0, pos.y)) / 12.0,
                       (sdfS(pos.x, pos.y + 6.0) - sdfS(pos.x, pos.y - 6.0)) / 12.0);
        let nl = length(n2);
        n2 = n2 / select(nl, 1.0, nl == 0.0);
        n3 = vec3f(n2, 0.0);
      }
      if (u.collMode == 2u) { n3 = -n3; }
      let pen = min(60.0, select(sd + 6.0, 6.0 - sd, u.collMode == 1u));
      pos += n3 * pen;
      let vn = dot(vel, n3);
      if (vn < 0.0) { vel -= n3 * vn * (1.0 + u.collBounce); }
    }
    if (u.collMode == 2u) {
      if (pos.z > hz) { pos.z = hz - (pos.z - hz); vel.z = -vel.z * 0.5; }
      else if (pos.z < -hz) { pos.z = -hz + (-hz - pos.z); vel.z = -vel.z * 0.5; }
    }
  }
  var alive = uidF;
  if (u.boundsMode == 1u) {
    if (pos.x > hx) { pos.x -= hx * 2.0; } else if (pos.x < -hx) { pos.x += hx * 2.0; }
    if (pos.y > hy) { pos.y -= hy * 2.0; } else if (pos.y < -hy) { pos.y += hy * 2.0; }
    if (pos.z > hz) { pos.z -= hz * 2.0; } else if (pos.z < -hz) { pos.z += hz * 2.0; }
  } else if (u.boundsMode == 2u) {
    if (pos.x > hx) { pos.x = hx - (pos.x - hx); vel.x = -vel.x * ${RESTITUTION}; }
    else if (pos.x < -hx) { pos.x = -hx + (-hx - pos.x); vel.x = -vel.x * ${RESTITUTION}; }
    if (pos.y > hy) { pos.y = hy - (pos.y - hy); vel.y = -vel.y * ${RESTITUTION}; }
    else if (pos.y < -hy) { pos.y = -hy + (-hy - pos.y); vel.y = -vel.y * ${RESTITUTION}; }
    if (pos.z > hz) { pos.z = hz - (pos.z - hz); vel.z = -vel.z * ${RESTITUTION}; }
    else if (pos.z < -hz) { pos.z = -hz + (-hz - pos.z); vel.z = -vel.z * ${RESTITUTION}; }
  } else if (abs(pos.x) > hx || abs(pos.y) > hy || abs(pos.z) > hz) {
    alive = 0.0;
  }
  parts[id] = Part(vec4f(pos, alive), vec4f(vel, f32(nearI)));
}
`;

// ── Device + pipelines (shared by every engine) ─────────────────────────────

let devicePromise = null;
const PIPES = new WeakMap();

/**
 * The one device every live engine shares, or null when WebGPU is missing or
 * the adapter cannot bind nine storage buffers. Cached; a lost device clears
 * the cache so the next engine asks again.
 */
export function gpuParticleDevice() {
  if (devicePromise) return devicePromise;
  devicePromise = (async () => {
    if (typeof navigator === 'undefined' || !navigator.gpu) return null;
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter || adapter.limits.maxStorageBuffersPerShaderStage < 9) return null;
    const device = await adapter.requestDevice({
      requiredLimits: { maxStorageBuffersPerShaderStage: Math.min(adapter.limits.maxStorageBuffersPerShaderStage, 10) },
    });
    device.lost.then(() => { devicePromise = null; PIPES.delete(device); });
    return device;
  })().catch(() => null);
  return devicePromise;
}

/*
 * THE HOME VARIANT. With Return on, every particle carries the point it was born
 * at — a third vec4 in its record — and integration closes part of the gap each
 * step, exactly as the bake does. Off, the record and the shader are the ones
 * this engine always had: the wider record is only paid for by a system that
 * asks for it.
 */
function shaderFor(home) {
  if (!home) return WGSL;
  const swap = (src, a, b) => {
    if (src.split(a).length !== 2) throw new Error('particle WGSL: home variant anchor missing: ' + a);
    return src.replace(a, b);
  };
  let w = WGSL;
  w = swap(w, 'struct Part { pos: vec4f, vel: vec4f }', 'struct Part { pos: vec4f, vel: vec4f, home: vec4f }');
  w = swap(w, '  pos += vel * u.dt;\n', '  pos += vel * u.dt;\n  pos += (p.home.xyz - pos) * u.ret.x;\n');
  w = swap(w, 'parts[id] = Part(vec4f(pos, alive), vec4f(vel, f32(nearI)));', 'parts[id] = Part(vec4f(pos, alive), vec4f(vel, f32(nearI)), p.home);');
  return w;
}

async function pipelinesFor(device, home = false) {
  let byDevice = PIPES.get(device);
  if (!byDevice) { byDevice = {}; PIPES.set(device, byDevice); }
  let p = byDevice[home ? 1 : 0];
  if (p) return p;
  const mod = device.createShaderModule({ code: shaderFor(home) });
  const info = await mod.getCompilationInfo();
  const errors = info.messages.filter((m) => m.type === 'error').map((m) => `${m.lineNum}:${m.linePos} ${m.message}`);
  if (errors.length) throw new Error('particle WGSL: ' + errors.join(' | '));
  const bgl = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
    ...Array.from({ length: 8 }, (_, i) => ({ binding: i + 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } })),
    { binding: 9, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
    { binding: 10, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
    { binding: 11, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
  ] });
  const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });
  const pipes = {};
  for (const name of ['splat_pass', 'curl_pass', 'forces_pass', 'advect_pass', 'mac_bwd', 'mac_correct', 'diffuse_pass', 'div_pass', 'jacobi_pass', 'project_pass', 'particle_pass']) {
    pipes[name] = device.createComputePipeline({ layout, compute: { module: mod, entryPoint: name } });
  }
  p = { bgl, pipes };
  byDevice[home ? 1 : 0] = p;
  return p;
}

// ── The engine ───────────────────────────────────────────────────────────────

/**
 * One live simulation of `system`. Resolve `engine.ready` before stepping
 * (false = no WebGPU here; use the cache). Then per frame:
 *   await engine.advanceTo(t)   — steps forward (or restarts and fast-forwards
 *                                 for a scrub back), at most `maxSteps` per call
 *   engine.sample(out, uids)    — the pool in sampleParticles' layout
 * `engine.stats` is what the governor reads. dispose() frees the buffers.
 */
export function createParticleGpuEngine(init) {
  let spawnTable = init.spawnTable || null, colliderTable = init.colliderTable || null;
  let layerDrive = init.layerDrive || null;
  const cfg = engineConfig(init.system, init.duration, spawnTable, colliderTable, layerDrive);
  const { maxP } = cfg;
  // Return widens each particle's record by its birth point: 12 floats, not 8.
  // Fixed for the engine's life — turning Return on or off rebuilds it.
  const home = cfg.retK > 0;
  const PF = home ? 12 : 8, PB = PF * 4;
  const hx = home ? new Float32Array(maxP) : null, hy = home ? new Float32Array(maxP) : null, hz = home ? new Float32Array(maxP) : null;
  const px = new Float32Array(maxP), py = new Float32Array(maxP), pz = new Float32Array(maxP);
  const vx = new Float32Array(maxP), vy = new Float32Array(maxP), vz = new Float32Array(maxP);
  const age = new Float32Array(maxP), life = new Float32Array(maxP);
  const uid = new Int32Array(maxP);
  const near = new Int32Array(maxP).fill(-1);
  // What the renderer SEES. The pool above is the simulation's working state
  // and passes through every intermediate step of a fast-forward; the shown
  // copy is updated only when a step lands ON the requested time, so a scrub
  // back never flashes the first frames of the clip on its way to the target.
  const shown = { px: new Float32Array(maxP), py: new Float32Array(maxP), pz: new Float32Array(maxP), vx: new Float32Array(maxP), vy: new Float32Array(maxP), vz: new Float32Array(maxP), age: new Float32Array(maxP), life: new Float32Array(maxP), uid: new Int32Array(maxP) };
  const S = { nextUid: 1, cursor: 0, aliveCount: 0, dropped: 0 };
  const spawned = [];
  let emission = null;
  const makeEmission = () => createEmission({
    arrays: { px, py, pz, vx, vy, vz, age, life, uid, near },
    S, em: cfg.em, seed: cfg.seed, maxP, spawnTable, colliderTable,
    distPool: cfg.maxP,
    collMode: cfg.collMode, collHalfD: cfg.collHalfD, emitPathS: cfg.emitPathS,
    onSpawn: (i) => {
      spawned.push(i);
      if (hx) { hx[i] = px[i]; hy[i] = py[i]; hz[i] = pz[i]; }
    },
  });
  const splats = [];
  const splatCtx = cfg.fluidOn ? { em: cfg.em, smoke: cfg.smoke, heat: cfg.FL.smoke.heat, jets: cfg.jets, smokers: cfg.smokers, fePos: cfg.fePos, seed: cfg.seed, arrays: { px, py, pz, vx, vy, vz }, sites: null } : null;

  const uF = new Float32Array(U_FLOATS);
  const splatPack = new Float32Array(MAX_SPLATS * 12);
  const partData = new Float32Array(maxP * PF);
  const slotPack = new Float32Array(PF);

  const engine = {
    live: true,
    cfg,
    maxP,
    duration: cfg.duration,
    t: -cfg.preRoll,
    ready: null,
    ok: false,
    busy: false,
    disposed: false,
    error: null,
    stats: { stepMs: 0, lastMs: 0, steps: 0, slowRun: 0, tooSlow: false, readbackMs: 0 },
    // Bumped whenever the pool changes, so a renderer that caches its sample by
    // time can tell a repaint at the same time apart from a stale one.
    version: 0,
    alive: () => S.aliveCount,
    sample,
    advanceTo,
    update,
    reset,
    dispose,
  };

  let device = null, pipes = null, bgl = null;
  let bufs = null, bg = null;
  let velIsB = 0;
  let acc = 0, stepIndex = 0;
  let firedBursts = null;
  let gen = 0;

  function resetPool() {
    uid.fill(0); near.fill(-1); age.fill(0);
    S.nextUid = 1; S.cursor = 0; S.aliveCount = 0; S.dropped = 0;
    emission = makeEmission();
    if (splatCtx) splatCtx.sites = emission.sites;
    acc = 0; stepIndex = 0;
    firedBursts = cfg.bursts.map(() => false);
    engine.t = -cfg.preRoll;
  }

  /** Publish the pool to the renderer. */
  function present() {
    shown.px.set(px); shown.py.set(py); shown.pz.set(pz);
    shown.vx.set(vx); shown.vy.set(vy); shown.vz.set(vz);
    shown.age.set(age); shown.life.set(life); shown.uid.set(uid);
    engine.version++;
  }

  /**
   * Take a new config WITHOUT restarting: sliders change the uniforms the next
   * step reads and the emitter the next spawn uses, the way the lab does —
   * that is what makes an edit show within a frame. Returns false when the
   * change is structural (pool size, grid size, field on/off): the caller
   * rebuilds the engine and it fast-forwards to the current time.
   */
  function update(next) {
    const nc = engineConfig(next.system, next.duration, next.spawnTable ?? null, next.colliderTable ?? null, next.layerDrive ?? null);
    if (nc.maxP !== cfg.maxP || nc.n !== cfg.n || nc.dims.nx !== cfg.dims.nx || nc.dims.ny !== cfg.dims.ny || nc.fluidOn !== cfg.fluidOn) return false;
    // Return on ↔ off changes the particle record and the shader: structural.
    if ((nc.retK > 0) !== home) return false;
    const samePath = (a, b) => (!a && !b) || (a && b && a.length === b.length && a.every((v, i) => v === b[i]));
    const pathChanged = !samePath(nc.followS, cfg.followS);
    const sdfChanged = (next.colliderTable ?? null) !== colliderTable || nc.collMode !== cfg.collMode;
    spawnTable = next.spawnTable ?? null;
    colliderTable = next.colliderTable ?? null;
    layerDrive = next.layerDrive ?? null;
    for (const k of Object.keys(nc)) cfg[k] = nc[k];
    engine.duration = cfg.duration;
    emission = makeEmission();
    if (splatCtx) { splatCtx.em = cfg.em; splatCtx.smoke = cfg.smoke; splatCtx.heat = cfg.FL.smoke.heat; splatCtx.jets = cfg.jets; splatCtx.smokers = cfg.smokers; splatCtx.fePos = cfg.fePos; splatCtx.sites = emission.sites; }
    if (firedBursts.length !== cfg.bursts.length) firedBursts = cfg.bursts.map((b) => b.time <= engine.t);
    if (device && bufs) {
      if (pathChanged && cfg.followS) writePath();
      if (sdfChanged && cfg.collMode && colliderTable) device.queue.writeBuffer(bufs.sdf, 0, colliderTable.sdf);
    }
    return true;
  }

  function writePath() {
    const Sp = cfg.followS, out = new Float32Array(PATH_N * 8);
    for (let i = 0; i < PATH_N; i++) {
      const o = i * 6, q = i * 8;
      out[q] = Sp[o]; out[q + 1] = Sp[o + 1]; out[q + 2] = Sp[o + 2];
      out[q + 4] = Sp[o + 3]; out[q + 5] = Sp[o + 4]; out[q + 6] = Sp[o + 5];
    }
    device.queue.writeBuffer(bufs.path, 0, out);
  }

  function reset() {
    resetPool();
    if (!device || !bufs) return;
    // the field restarts clean
    device.queue.writeBuffer(bufs.velA, 0, new Float32Array(cfg.n * 4));
    device.queue.writeBuffer(bufs.velB, 0, new Float32Array(cfg.n * 4));
    device.queue.writeBuffer(bufs.heatA, 0, new Float32Array(cfg.n));
    device.queue.writeBuffer(bufs.heatB, 0, new Float32Array(cfg.n));
    device.queue.writeBuffer(bufs.parts, 0, new Float32Array(maxP * PF));
    velIsB = 0;
  }

  function build() {
    const d = device, n = cfg.n;
    const mk = (size, usage) => d.createBuffer({ size, usage });
    const ST = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    bufs = {
      u: mk(U_BYTES, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST),
      velA: mk(n * 16, ST), velB: mk(n * 16, ST),
      heatA: mk(n * 4, ST), heatB: mk(n * 4, ST),
      prsA: mk(n * 4, ST), prsB: mk(n * 4, ST),
      aux: mk(n * 16, ST),
      parts: mk(maxP * PB, ST),
      path: mk(PATH_N * 32, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST),
      splats: mk(MAX_SPLATS * 48, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST),
      sdf: mk(SDF_W * SDF_H * 4, ST),
      stage: d.createBuffer({ size: maxP * PB, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
    };
    const mkbg = (vB, pB) => d.createBindGroup({ layout: bgl, entries: [
      { binding: 0, resource: { buffer: bufs.u } },
      { binding: 1, resource: { buffer: vB ? bufs.velB : bufs.velA } },
      { binding: 2, resource: { buffer: vB ? bufs.velA : bufs.velB } },
      { binding: 3, resource: { buffer: vB ? bufs.heatB : bufs.heatA } },
      { binding: 4, resource: { buffer: vB ? bufs.heatA : bufs.heatB } },
      { binding: 5, resource: { buffer: pB ? bufs.prsB : bufs.prsA } },
      { binding: 6, resource: { buffer: pB ? bufs.prsA : bufs.prsB } },
      { binding: 7, resource: { buffer: bufs.aux } },
      { binding: 8, resource: { buffer: bufs.parts } },
      { binding: 9, resource: { buffer: bufs.path } },
      { binding: 10, resource: { buffer: bufs.splats } },
      { binding: 11, resource: { buffer: bufs.sdf } },
    ] });
    bg = [[mkbg(0, 0), mkbg(0, 1)], [mkbg(1, 0), mkbg(1, 1)]];
    // static tables: the follow path and the collider's SDF
    if (cfg.followS) writePath();
    if (cfg.collMode && colliderTable) d.queue.writeBuffer(bufs.sdf, 0, colliderTable.sdf);
    reset();
  }

  engine.ready = (async () => {
    try {
      device = await gpuParticleDevice();
      if (!device) return false;
      ({ pipes, bgl } = await pipelinesFor(device, home));
      if (engine.disposed) return false;
      build();
      engine.ok = true;
      return true;
    } catch (e) {
      engine.error = String(e?.message || e);
      return false;
    }
  })();
  resetPool();

  /** CPU half of one step: ageing, emission, splats. Returns the step's time. */
  function cpuStep() {
    const t = engine.t + STEP_DT;
    for (let i = 0; i < maxP; i++) {
      if (!uid[i]) continue;
      age[i] += STEP_DT;
      if (age[i] >= life[i]) { uid[i] = 0; S.aliveCount--; }
    }
    const em = cfg.em;
    if (!cfg.staticEmit && t >= em.start - cfg.preRoll && t <= em.end) {
      acc += em.rate * STEP_DT;
      const n = Math.floor(acc);
      acc -= n;
      if (n > 0) emission.spawn(n);
    }
    for (let b = 0; b < cfg.bursts.length; b++) {
      if (!firedBursts[b] && t >= cfg.bursts[b].time) { firedBursts[b] = true; emission.spawn(cfg.bursts[b].count); }
    }
    if (splatCtx) fieldSplats(splats, splatCtx, t, stepIndex); else splats.length = 0;
    // A layer sweeping through shoves the medium too — same splat the bake adds.
    if (splatCtx && cfg.layerDrive) layerDriveSplats(splats, cfg.layerDrive, Math.round((t + cfg.preRoll) / STEP_DT), cfg.drivers || []);
    emission.sites.length = 0;
    stepIndex++;
    engine.t = t;
    return t;
  }

  function packSlot(out, o, i) {
    out[o] = px[i]; out[o + 1] = py[i]; out[o + 2] = pz[i]; out[o + 3] = uid[i];
    out[o + 4] = vx[i]; out[o + 5] = vy[i]; out[o + 6] = vz[i]; out[o + 7] = near[i];
    if (hx) { out[o + 8] = hx[i]; out[o + 9] = hy[i]; out[o + 10] = hz[i]; out[o + 11] = 0; }
  }

  function writeStep(t) {
    const d = device;
    packUniforms(uF, cfg, t, Math.min(MAX_SPLATS, splats.length));
    d.queue.writeBuffer(bufs.u, 0, uF);
    if (splats.length) {
      const ns = Math.min(MAX_SPLATS, splats.length);
      for (let s = 0; s < ns; s++) {
        const o = s * 12, sp = splats[s];
        splatPack[o] = sp.x; splatPack[o + 1] = sp.y; splatPack[o + 2] = sp.z; splatPack[o + 3] = sp.r;
        splatPack[o + 4] = sp.tvx; splatPack[o + 5] = sp.tvy; splatPack[o + 6] = sp.tvz; splatPack[o + 7] = sp.k;
        splatPack[o + 8] = sp.den; splatPack[o + 9] = sp.heat; splatPack[o + 10] = 0; splatPack[o + 11] = 0;
      }
      d.queue.writeBuffer(bufs.splats, 0, splatPack, 0, ns * 12);
    }
  }

  function encodeStep(enc) {
    const gN = cfg.n, pN = maxP;
    let vB = velIsB, pB = 0;
    const run = (name, count, after) => {
      const pass = enc.beginComputePass();
      pass.setPipeline(pipes[name]);
      pass.setBindGroup(0, bg[vB][pB]);
      const groups = Math.ceil(count / 64);
      pass.dispatchWorkgroups(Math.min(256, groups), Math.ceil(groups / 256));
      pass.end();
      if (after) after();
    };
    if (cfg.fluidOn) {
      const FL = cfg.FL;
      if (splats.length) run('splat_pass', gN);
      const forcesOn = cfg.smoke || FL.swirl > 0.5 || (cfg.F.draft && cfg.F.draft.strength > 0) || cfg.vortOn || cfg.vortices.length;
      if (forcesOn) { if (FL.swirl > 0.5) run('curl_pass', gN); run('forces_pass', gN); }
      if (FL.sharp) {
        run('advect_pass', gN);
        run('mac_bwd', gN);
        run('mac_correct', gN, () => { vB = 1 - vB; });
      } else {
        run('advect_pass', gN, () => { vB = 1 - vB; });
      }
      if (FL.viscosity >= 0.5) { run('diffuse_pass', gN, () => { vB = 1 - vB; }); run('diffuse_pass', gN, () => { vB = 1 - vB; }); }
      run('div_pass', gN);
      for (let it = 0; it < (FL.pressureSteps | 0); it++) run('jacobi_pass', gN, () => { pB = 1 - pB; });
      run('project_pass', gN);
    }
    run('particle_pass', pN);
    velIsB = vB;
  }

  /**
   * Run `k` steps with one readback at the end. The first step uploads the whole
   * pool (coherent after the last readback); later steps upload only the slots
   * they spawned, because the GPU's copy of everything else is ahead of ours.
   */
  async function runBatch(k) {
    const d = device;
    const myGen = gen;
    for (let s = 0; s < k; s++) {
      spawned.length = 0;
      const t = cpuStep();
      writeStep(t);
      if (s === 0) {
        for (let i = 0; i < maxP; i++) packSlot(partData, i * PF, i);
        d.queue.writeBuffer(bufs.parts, 0, partData);
      } else {
        for (let q = 0; q < spawned.length; q++) {
          const i = spawned[q];
          packSlot(slotPack, 0, i);
          d.queue.writeBuffer(bufs.parts, i * PB, slotPack);
        }
      }
      const enc = d.createCommandEncoder();
      encodeStep(enc);
      if (s === k - 1) enc.copyBufferToBuffer(bufs.parts, 0, bufs.stage, 0, maxP * PB);
      d.queue.submit([enc.finish()]);
    }
    const t0 = performance.now();
    try {
      await bufs.stage.mapAsync(GPUMapMode.READ);
    } catch { return false; }   // disposed mid-flight
    if (gen !== myGen || engine.disposed) { try { bufs.stage.unmap(); } catch { /* gone */ } return false; }
    const back = new Float32Array(bufs.stage.getMappedRange());
    for (let i = 0; i < maxP; i++) {
      if (!uid[i]) continue;
      const o = i * PF;
      if (back[o + 3] < 0.5) { uid[i] = 0; S.aliveCount--; continue; }
      px[i] = back[o]; py[i] = back[o + 1]; pz[i] = back[o + 2];
      vx[i] = back[o + 4]; vy[i] = back[o + 5]; vz[i] = back[o + 6];
      near[i] = back[o + 7] | 0;
    }
    bufs.stage.unmap();
    engine.stats.readbackMs = performance.now() - t0;
    return true;
  }

  function noteTiming(ms, steps) {
    const st = engine.stats;
    const per = ms / Math.max(1, steps);
    st.lastMs = per;
    st.steps += steps;
    st.stepMs = st.stepMs ? st.stepMs + (per - st.stepMs) * 0.15 : per;
    if (per > slowStepMs) st.slowRun += steps; else st.slowRun = 0;
    if (st.slowRun >= SLOW_RUN) st.tooSlow = true;
  }

  /**
   * Bring the simulation to clip time `target`. Forward by up to `maxSteps`
   * (a frame that fell behind catches up gradually, never with a hitch);
   * backward, or too far ahead to catch up, restarts and fast-forwards in
   * batches. Returns true when the pool changed.
   */
  async function advanceTo(target, maxSteps = 3) {
    if (!engine.ok || engine.busy || engine.disposed) return false;
    const tt = clamp(target, 0, cfg.duration);
    let steps = Math.floor((tt - engine.t) / STEP_DT + 1e-6);
    if (steps <= 0 && tt >= engine.t - STEP_DT * 0.5) return false;   // already there
    engine.busy = true;
    const t0 = performance.now();
    let changed = false;
    try {
      if (tt < engine.t - STEP_DT * 0.5 || steps > BATCH_STEPS * 4) {
        // scrub: restart and run to the target in batches
        reset();
        steps = Math.max(0, Math.round((tt + cfg.preRoll) / STEP_DT));
        let done = 0;
        while (done < steps && !engine.disposed) {
          const k = Math.min(BATCH_STEPS, steps - done);
          if (!(await runBatch(k))) break;
          done += k;
          changed = true;
        }
        if (changed) present();   // once, at the target — never the frames on the way
      } else if (steps > 0) {
        const k = Math.min(maxSteps, steps);
        changed = await runBatch(k);
        steps = k;
        if (changed) present();
      }
      if (changed) noteTiming(performance.now() - t0, steps);
    } finally {
      engine.busy = false;
    }
    return changed;
  }

  /** The pool in sampleParticles' layout; returns the live count. */
  function sample(out, outUid) {
    const { px: sx, py: sy, pz: sz, vx: svx, vy: svy, vz: svz, age: sage, life: slife, uid: suid } = shown;
    let n = 0;
    for (let i = 0; i < maxP; i++) {
      if (!suid[i]) continue;
      const k = n * SAMPLE_STRIDE;
      out[k] = sx[i]; out[k + 1] = sy[i]; out[k + 2] = sz[i];
      out[k + 3] = sage[i]; out[k + 4] = slife[i];
      out[k + 5] = svx[i]; out[k + 6] = svy[i]; out[k + 7] = svz[i];
      out[k + 8] = TTL_ALIVE; out[k + 9] = 0;
      outUid[n] = suid[i];
      n++;
    }
    return n;
  }

  function dispose() {
    engine.disposed = true;
    engine.ok = false;
    gen++;
    if (bufs) for (const b of Object.values(bufs)) { try { b.destroy(); } catch { /* already gone */ } }
    bufs = null; bg = null;
  }

  return engine;
}
