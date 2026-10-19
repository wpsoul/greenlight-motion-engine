/*
 * The FLUID, on 3D textures — Phase 5 of
 * PLANS/VIDEO_EDITOR_PARTICLE_GPU_SCALE_PLAN.md.
 *
 * A port of the solver in gpuEngine.js (splat, forces, advect, MacCormack,
 * divergence, Jacobi pressure, project) from flat storage buffers to 3D
 * textures. Same maths, same constants, same order.
 *
 * WHY TEXTURES. Advection is the hot pass and it is a resample: for every cell
 * it traces backwards and reads the field at a point between cells. On a
 * storage buffer that is EIGHT loads and a hand-written trilerp; on a sampled
 * 3D texture it is ONE textureSampleLevel and the filtering hardware does the
 * rest. That is the single biggest win in the solve, and it is why the layout
 * below bends around what is filterable rather than what is tidy.
 *
 * THE LAYOUT, and why it is not the obvious one:
 *
 *   vel  rgba16float   xyz = velocity, w = spare
 *   mat  rgba16float   x = density, y = heat, z = divergence, w = spare
 *   prs  r32float      pressure
 *
 * Core WebGPU allows only a specific set of storage-texture formats, and
 * `r16float` is NOT among them — so the scalar fields cannot each have their own
 * half-precision texture. Packing density, heat and divergence into one
 * `rgba16float` costs nothing (they are written together anyway) and keeps them
 * FILTERABLE, which density and heat both need because advection resamples them.
 *
 * Pressure stays `r32float` for two reasons. Jacobi reads its neighbours by
 * TEXEL, never filtered, so it gains nothing from being in the packed texture;
 * and pressure is the one field here whose magnitude is unbounded — an fp16
 * pressure would lose the low end of a converging solve, which shows up as a
 * field that will not settle rather than as anything obviously wrong.
 * `r32float` is storage-capable in core WebGPU and needs no optional feature.
 *
 * Divergence rides in mat.z rather than owning a texture: it is written once per
 * step and read once per Jacobi iteration, always by texel.
 *
 * EVERY PASS PING-PONGS. A WGSL storage texture is write-only without an
 * optional feature, so no pass reads and writes the same texture. Each takes a
 * sampled source and a storage destination, and the caller swaps.
 */

/** Storage formats. Both are core WebGPU — no optional feature is required. */
export const VEL_FORMAT = 'rgba16float';
export const MAT_FORMAT = 'rgba16float';
export const PRS_FORMAT = 'r32float';

export const FLUID_U_FLOATS = 32;
export const FLUID_U_BYTES = FLUID_U_FLOATS * 4;

/** Lane order of the fluid uniform block — mirrored by the JS packer. */
export const FLUID_KEYS = [
  'nx', 'ny', 'nz', 'dt',
  'hx', 'hy', 'hz', 'smoke',
  'buoy', 'weight', 'cooling', 'dissipate',
  'fade', 'swirlEps', 'swirlR', 'boundsOpen',
  'windX', 'windY', 'nSplats', 'viscA',
  'boxX', 'boxY', 'boxZ', 'denK',
  'heatK', 'fadeK', 'vortOn', 'vortStr',
  'vortScale', 'vortMode', 'vortAxis', 'vortLift',
];

/** A splat: centre + radius, target velocity + blend, density and heat. */
export const SPLAT_FLOATS = 12;

export const FLUID_WGSL = /* wgsl */ `
struct U {
  nx: f32, ny: f32, nz: f32, dt: f32,
  hx: f32, hy: f32, hz: f32, smoke: f32,
  buoy: f32, weight: f32, cooling: f32, dissipate: f32,
  fade: f32, swirlEps: f32, swirlR: f32, boundsOpen: f32,
  windX: f32, windY: f32, nSplats: f32, viscA: f32,
  boxX: f32, boxY: f32, boxZ: f32, denK: f32,
  heatK: f32, fadeK: f32, vortOn: f32, vortStr: f32,
  vortScale: f32, vortMode: f32, vortAxis: f32, vortLift: f32,
};
struct Splat { c: vec4f, v: vec4f, m: vec4f };   // centre+radius, targetVel+k, den/heat

@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var velSrc: texture_3d<f32>;
@group(0) @binding(2) var velDst: texture_storage_3d<${VEL_FORMAT}, write>;
@group(0) @binding(3) var matSrc: texture_3d<f32>;
@group(0) @binding(4) var matDst: texture_storage_3d<${MAT_FORMAT}, write>;
@group(0) @binding(5) var prsSrc: texture_3d<f32>;
@group(0) @binding(6) var prsDst: texture_storage_3d<${PRS_FORMAT}, write>;
@group(0) @binding(7) var samp: sampler;
@group(0) @binding(8) var<storage, read> splats: array<Splat>;

fn dims() -> vec3i { return vec3i(i32(u.nx), i32(u.ny), i32(u.nz)); }
fn cellOf(g: vec3u) -> vec3i { return vec3i(g); }
fn inside(c: vec3i) -> bool {
  let d = dims();
  return c.x >= 0 && c.y >= 0 && c.z >= 0 && c.x < d.x && c.y < d.y && c.z < d.z;
}
/* Clamped texel fetch — a read past the edge returns the edge, which is the
   Neumann condition the buffer solver got from its clamping index tables. */
fn cl(c: vec3i) -> vec3i { return clamp(c, vec3i(0), dims() - vec3i(1)); }
fn velAt(c: vec3i) -> vec3f { return textureLoad(velSrc, cl(c), 0).xyz; }
fn matAt(c: vec3i) -> vec4f { return textureLoad(matSrc, cl(c), 0); }
fn prsAt(c: vec3i) -> f32 {
  if (u.boundsOpen > 0.5 && !inside(c)) { return 0.0; }   // Dirichlet outflow
  return textureLoad(prsSrc, cl(c), 0).x;
}

/* Grid coordinates -> normalised texture coordinates, at cell CENTRES. The half
   texel matters: sampling at c/dims lands on a corner and the whole field
   shifts by half a cell every advection, which reads as a slow drift. */
fn uvw(g: vec3f) -> vec3f { return (g + vec3f(0.5)) / vec3f(f32(u.nx), f32(u.ny), f32(u.nz)); }
fn sampleVel(g: vec3f) -> vec3f { return textureSampleLevel(velSrc, samp, uvw(g), 0.0).xyz; }
fn sampleMat(g: vec3f) -> vec4f { return textureSampleLevel(matSrc, samp, uvw(g), 0.0); }

fn cellWorld(c: vec3i) -> vec3f {
  let d = vec3f(f32(u.nx), f32(u.ny), f32(u.nz));
  let f = (vec3f(c) + vec3f(0.5)) / d - vec3f(0.5);
  return f * vec3f(u.boxX, u.boxY, u.boxZ);
}

/* ── splat: emitters push velocity, density and heat into the field ───────── */

@compute @workgroup_size(4, 4, 4)
fn splat(@builtin(global_invocation_id) gid: vec3u) {
  let c = cellOf(gid);
  if (!inside(c)) { return; }
  let wp = cellWorld(c);
  var v = textureLoad(velSrc, c, 0);
  var m = textureLoad(matSrc, c, 0);
  let n = i32(u.nSplats);
  for (var i = 0; i < n; i = i + 1) {
    let s = splats[i];
    // GAUSSIAN, NOT A CONE, and every constant here is the bake's.
    //
    // The first version used a hard cutoff at the radius with a squared linear
    // falloff, left the dt out of the velocity mix, and did not clamp the
    // material. All three are wrong in the same direction — a cone deposits far
    // less than a Gaussian of the same radius, and a mix without dt applies a
    // whole step's worth of velocity every step regardless of step size.
    let d = (wp - s.c.xyz) / max(s.c.w, 1e-5);
    let w = exp(-dot(d, d));
    if (w < 1e-3) { continue; }
    let a = clamp(s.v.w * w * u.dt * 10.0, 0.0, 1.0);
    v = vec4f(v.xyz + (s.v.xyz - v.xyz) * a, v.w);
    // Material saturates: a source held over one spot must not run away.
    m = vec4f(min(2.0, m.x + s.m.x * w * u.dt),
              min(2.0, m.y + s.m.y * w * u.dt), m.z, m.w);
  }
  textureStore(velDst, c, v);
  textureStore(matDst, c, m);
}

/* THE VORTEX FIELD, lifted from gpuEngine.js. The bake applies this to the GRID
   as well as to the particles: a vortex that only pushes particles leaves the
   medium they are suspended in going straight, so the two disagree and the
   plume never takes the shape the field is supposed to give it. */
fn fieldAccel(p: vec3f) -> vec3f {
  var ax: f32; var ay: f32;
  if (u32(u.vortAxis + 0.5) == 0u) { ax = p.y; ay = p.z; }
  else if (u32(u.vortAxis + 0.5) == 2u) { ax = p.x; ay = p.y; }
  else { ax = p.x; ay = p.z; }
  let r0 = length(vec2f(ax, ay));
  let r = select(r0, 1e-3, r0 == 0.0);
  let k = r / u.vortScale;
  let fall = 1.0 / (1.0 + k * k);
  let s = u.vortStr * fall;
  let rx = ax / r; let ry = ay / r;
  let tx = -ry; let ty = rx;
  var a = 0.0; var b = 0.0; var w = 0.0;
  if (u32(u.vortMode + 0.5) == 3u) { a = -rx * s; b = -ry * s; }
  else if (u32(u.vortMode + 0.5) == 4u) { a = rx * s; b = ry * s; }
  else if (u32(u.vortMode + 0.5) == 1u) { a = tx * s; b = ty * s; }
  else if (u32(u.vortMode + 0.5) == 2u) { a = tx * s; b = ty * s; w = s * u.vortLift * fall; }
  else { a = tx * s - rx * s * 0.18; b = ty * s - ry * s * 0.18; }
  if (u32(u.vortAxis + 0.5) == 0u) { return vec3f(w, a, b); }
  if (u32(u.vortAxis + 0.5) == 2u) { return vec3f(a, b, w); }
  return vec3f(a, w, b);
}

/* ── forces: buoyancy, wind, vorticity confinement, the vortex field ─────── */

@compute @workgroup_size(4, 4, 4)
fn forces(@builtin(global_invocation_id) gid: vec3u) {
  let c = cellOf(gid);
  if (!inside(c)) { return; }
  var v = textureLoad(velSrc, c, 0);
  let m = textureLoad(matSrc, c, 0);
  if (u.smoke > 0.5) {
    // Hot rises, dense sinks — the same two-term buoyancy the buffer solver uses.
    v.y = v.y + (u.buoy * m.y - u.weight * m.x) * u.dt;
  }
  if (abs(u.windX) + abs(u.windY) > 0.0) {
    v.x = v.x + u.windX * u.dt;
    v.y = v.y + u.windY * u.dt;
  }
  if (u.vortOn > 0.5) { v = vec4f(v.xyz + fieldAccel(cellWorld(c)) * u.dt, v.w); }
  if (u.swirlEps > 0.0) {
    // Vorticity confinement: push along (normalised grad|curl|) x curl, which
    // puts back the small eddies a first-order advection scheme eats.
    let R = i32(max(1.0, u.swirlR));
    let cm = curlMag(c, R);
    var nrm = vec3f(
      (cm.x - cm.y) / (2.0 * u.hx * f32(R)),
      (cm.z - cm.w) / (2.0 * u.hy * f32(R)),
      (curlMagZ(c, R).x - curlMagZ(c, R).y) / (2.0 * u.hz * f32(R)));
    nrm = nrm / (length(nrm) + 1e-5);
    v = vec4f(v.xyz + u.swirlEps * cross(nrm, curlAt(c)) * u.dt, v.w);
  }
  textureStore(velDst, c, v);
  textureStore(matDst, c, m);
}

fn curlAt(c: vec3i) -> vec3f {
  let dx = (velAt(c + vec3i(1,0,0)) - velAt(c - vec3i(1,0,0))) / (2.0 * u.hx);
  let dy = (velAt(c + vec3i(0,1,0)) - velAt(c - vec3i(0,1,0))) / (2.0 * u.hy);
  let dz = (velAt(c + vec3i(0,0,1)) - velAt(c - vec3i(0,0,1))) / (2.0 * u.hz);
  return vec3f(dy.z - dz.y, dz.x - dx.z, dx.y - dy.x);
}
fn curlMag(c: vec3i, R: i32) -> vec4f {
  return vec4f(
    length(curlAt(c + vec3i(R,0,0))), length(curlAt(c - vec3i(R,0,0))),
    length(curlAt(c + vec3i(0,R,0))), length(curlAt(c - vec3i(0,R,0))));
}
fn curlMagZ(c: vec3i, R: i32) -> vec2f {
  return vec2f(length(curlAt(c + vec3i(0,0,R))), length(curlAt(c - vec3i(0,0,R))));
}

/* ── advect: THE pass textures exist for ─────────────────────────────────── */

@compute @workgroup_size(4, 4, 4)
fn advect(@builtin(global_invocation_id) gid: vec3u) {
  let c = cellOf(gid);
  if (!inside(c)) { return; }
  let v = textureLoad(velSrc, c, 0).xyz;
  // Trace backwards and resample. ONE filtered fetch each, where the buffer
  // solver needed eight loads and a hand-written trilerp.
  let g = vec3f(c) - v * u.dt / vec3f(u.hx, u.hy, u.hz);
  let nv = sampleVel(g) * u.fadeK;
  var nm = sampleMat(g);
  if (u.smoke > 0.5) { nm = vec4f(nm.x * u.denK, nm.y * u.heatK, nm.z, nm.w); }
  // The same CFL clamp: a velocity that would cross more than a couple of cells
  // in one step makes the backward trace meaningless, so cap it.
  let vcap = 2.5 * vec3f(u.hx, u.hy, u.hz) / u.dt;
  textureStore(velDst, c, vec4f(clamp(nv, -vcap, vcap), 0.0));
  textureStore(matDst, c, nm);
}

/* ── diffuse: viscosity ──────────────────────────────────────────────────── */

/*
 * Every shipped fluid preset has viscosity between 2 and 10, and the bake runs
 * this pass TWICE per step for all of them. Leaving it out is not a subtle
 * quality difference: nothing damps the velocity, so a buoyant column keeps
 * accelerating and climbs about three times as far in the same time. A
 * Cigarette that should be a short buckling column became a tall one.
 */
@compute @workgroup_size(4, 4, 4)
fn diffuse(@builtin(global_invocation_id) gid: vec3u) {
  let c = cellOf(gid);
  if (!inside(c)) { return; }
  let avg = (velAt(c + vec3i(1,0,0)) + velAt(c - vec3i(1,0,0))
           + velAt(c + vec3i(0,1,0)) + velAt(c - vec3i(0,1,0))
           + velAt(c + vec3i(0,0,1)) + velAt(c - vec3i(0,0,1))) / 6.0;
  let src = textureLoad(velSrc, c, 0);
  textureStore(velDst, c, vec4f(mix(src.xyz, avg, u.viscA * 0.5), src.w));
  textureStore(matDst, c, textureLoad(matSrc, c, 0));
}

/* ── divergence -> mat.z, and clear the pressure ─────────────────────────── */

@compute @workgroup_size(4, 4, 4)
fn divergence(@builtin(global_invocation_id) gid: vec3u) {
  let c = cellOf(gid);
  if (!inside(c)) { return; }
  let d = (velAt(c + vec3i(1,0,0)).x - velAt(c - vec3i(1,0,0)).x) / (2.0 * u.hx)
        + (velAt(c + vec3i(0,1,0)).y - velAt(c - vec3i(0,1,0)).y) / (2.0 * u.hy)
        + (velAt(c + vec3i(0,0,1)).z - velAt(c - vec3i(0,0,1)).z) / (2.0 * u.hz);
  let m = textureLoad(matSrc, c, 0);
  textureStore(matDst, c, vec4f(m.x, m.y, d, m.w));
  textureStore(prsDst, c, vec4f(0.0));
}

/* ── Jacobi: one iteration of the pressure solve ─────────────────────────── */

@compute @workgroup_size(4, 4, 4)
fn jacobi(@builtin(global_invocation_id) gid: vec3u) {
  let c = cellOf(gid);
  if (!inside(c)) { return; }
  let cx = 1.0 / (u.hx * u.hx);
  let cy = 1.0 / (u.hy * u.hy);
  let cz = 1.0 / (u.hz * u.hz);
  let div = textureLoad(matSrc, c, 0).z;
  let p = (cx * (prsAt(c - vec3i(1,0,0)) + prsAt(c + vec3i(1,0,0)))
         + cy * (prsAt(c - vec3i(0,1,0)) + prsAt(c + vec3i(0,1,0)))
         + cz * (prsAt(c - vec3i(0,0,1)) + prsAt(c + vec3i(0,0,1)))
         - div) / (2.0 * (cx + cy + cz));
  textureStore(prsDst, c, vec4f(p, 0.0, 0.0, 0.0));
}

/* ── project: subtract the pressure gradient, apply the walls ────────────── */

@compute @workgroup_size(4, 4, 4)
fn project(@builtin(global_invocation_id) gid: vec3u) {
  let c = cellOf(gid);
  if (!inside(c)) { return; }
  var v = textureLoad(velSrc, c, 0);
  v.x = v.x - (prsAt(c + vec3i(1,0,0)) - prsAt(c - vec3i(1,0,0))) / (2.0 * u.hx);
  v.y = v.y - (prsAt(c + vec3i(0,1,0)) - prsAt(c - vec3i(0,1,0))) / (2.0 * u.hy);
  v.z = v.z - (prsAt(c + vec3i(0,0,1)) - prsAt(c - vec3i(0,0,1))) / (2.0 * u.hz);
  let d = dims();
  if (u.boundsOpen < 0.5) {
    // Closed box: no flow THROUGH a wall, free to slide along it.
    if (c.x == 0 || c.x == d.x - 1) { v.x = 0.0; }
    if (c.y == 0 || c.y == d.y - 1) { v.y = 0.0; }
    if (c.z == 0 || c.z == d.z - 1) { v.z = 0.0; }
  } else {
    // Open: taper the last few cells instead of a hard edge, or the outflow
    // reflects back in as a visible ring.
    let e = min(min(min(c.x, d.x - 1 - c.x), min(c.y, d.y - 1 - c.y)), min(c.z, d.z - 1 - c.z));
    if (e < 3) { v = vec4f(v.xyz * (0.75 + 0.25 * f32(e) / 3.0), v.w); }
  }
  textureStore(velDst, c, v);
  textureStore(matDst, c, textureLoad(matSrc, c, 0));
}
`;
