/*
 * WGSL port of the instanced billboard in particleLayer.js (VERT/FRAG) and its
 * TSL twin in particleNodes.js — Phase 1 of
 * PLANS/VIDEO_EDITOR_PARTICLE_GPU_SCALE_PLAN.md.
 *
 * WHY A THIRD COPY OF THIS SHADER EXISTS. The GLSL original and the TSL twin
 * both run inside three, on three's device, fed by five instanced vertex
 * attributes the CPU fills each frame. Tier 2 draws on its OWN device, from a
 * storage buffer the CPU never touches, so it needs a shader that three does
 * not compile. The three must stay in step; the pixel A/B in
 * tests/particles-gpu-scale/ is what holds them there.
 *
 * PORTED VERBATIM, and that word is load-bearing. Every constant, every
 * multiply order and every clamp below is transcribed from the GLSL rather than
 * re-derived — including the ones that look redundant. Two of them are not:
 *
 *   * `spark()` is NOT symmetric in y (`p.y + 0.55` puts the head at one end),
 *     so the quad's orientation is observable in the output. Getting the corner
 *     winding "close enough" flips every spark in the system.
 *   * the velocity-stretch basis MUST stay right-handed — det([side, fwd]) = +1.
 *     A mirrored basis turns the quad back-facing and it is silently culled.
 *     This is called out in the app's own note and is reproduced here exactly.
 *
 * NO VERTEX BUFFERS. The quad is expanded from `vertex_index` and the pool is
 * read as a storage buffer by `instance_index`. That is what lets the instance
 * count come from an indirect draw later (Phase 3) instead of from the CPU.
 *
 * The lane map, FOUR banks (see layout.js for what the fifth carried and why
 * it is gone — rotation, squash, held and ignite are all constants on this
 * engine, and moving constants through memory is still bandwidth):
 *   a  xyz = position          w = speedT
 *   b  xy  = age, life         zw = jitter (size multiplier, twinkle phase)
 *   c  xyz = velocity          w  = kill scale
 *   d  xyz = emitted colour    w  = kill alpha
 *
 * EXPLICIT LOD ON EVERY SAMPLE, and it is not a stylistic choice. WGSL's
 * uniformity analysis rejects `textureSample` in control flow that a `discard`
 * has already made non-uniform — and this shader discards twice before it is
 * done sampling. GLSL has no such rule (it has undefined behaviour instead),
 * which is why the original compiles. `textureSampleLevel(..., 0.0)` carries no
 * uniformity requirement and is EXACTLY equivalent here: none of the three
 * textures has mipmaps bound, so level 0 is the only level there is.
 */

/** Floats per instance — the GLSL's five vec4s, unchanged. Declared in
 *  layout.js so tier.js can size a pool without importing any shader text. */
export { INST_FLOATS, INST_BYTES } from './layout.js';

/** Uniform block: two mat4 (128 B) then 16 scalars then a vec4. */
export const DRAW_U_FLOATS = 32 + 16 + 4;
export const DRAW_U_BYTES = DRAW_U_FLOATS * 4;

export const DRAW_WGSL = /* wgsl */ `
struct Inst { a: vec4f, b: vec4f, c: vec4f, d: vec4f };

struct U {
  mv: mat4x4f,
  proj: mat4x4f,
  sizeStart: f32, sizeEnd: f32, stretch: f32, scale: f32,
  twinkle: f32, aspect: f32, opacity: f32, sprite: f32,
  useMap: f32, tint: f32, colorFromSource: f32, colorFromSpeed: f32,
  igniteMode: f32, _p0: f32, _p1: f32, _p2: f32,
  igniteColor: vec4f,
};

@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> inst: array<Inst>;
@group(0) @binding(2) var ramp: texture_2d<f32>;
@group(0) @binding(3) var ramp2: texture_2d<f32>;
@group(0) @binding(4) var artMap: texture_2d<f32>;
@group(0) @binding(5) var samp: sampler;

struct VO {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) lifeT: f32,
  @location(2) kill: f32,
  @location(3) color: vec3f,
  @location(4) speedT: f32,
  @location(5) alphaMul: f32,
};

/* PlaneGeometry(1,1) expanded by hand: positions in [-0.5, 0.5], uv = pos + 0.5.

   FOUR VERTICES, AS A TRIANGLE STRIP, not six as a list. The floor cost of this
   draw is vertex-count bound — at four million particles, six vertices each is
   24M invocations and about 14 ms before a single pixel is shaded — so dropping
   to four is a third of that work for nothing in return. A strip re-uses v1 and
   v2 for the second triangle, which is exactly the quad topology.

   The winding differs from three's index order, and that is fine here for one
   specific reason: the pipeline sets cullMode 'none' (the original material is
   DoubleSide, because a billboard has no back face and a winding flip from the
   stretch basis must never make a particle invisible). What DOES still matter is
   which corner is which — spark() is not symmetric in y and the stretch basis is
   built from the corner offsets — and that is preserved: corner i is the same
   position and the same uv as before. */
fn corner(vi: u32) -> vec2f {
  var quad = array<vec2f, 4>(
    vec2f(-0.5,  0.5), vec2f( 0.5,  0.5),
    vec2f(-0.5, -0.5), vec2f( 0.5, -0.5));
  return quad[vi];
}

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VO {
  let I = inst[ii];
  let iPos = I.a.xyz;
  let iSpeedT = I.a.w;
  let iAge = I.b.x;
  let iLife = I.b.y;
  let iJitter = I.b.zw;
  let iVel = I.c.xyz;
  let iKillScale = I.c.w;
  let iColor = I.d.xyz;
  let iKillAlpha = I.d.w;

  let lifeT = clamp(iAge / max(iLife, 1e-4), 0.0, 1.0);
  let g = corner(vi);

  let size = mix(u.sizeStart, u.sizeEnd, lifeT) * iJitter.x * u.scale * iKillScale;

  // Billboard: the quad is built in VIEW space, so it faces the camera whatever
  // the layer's own rotation is. No rotation and no squash term — both belong
  // to object mode, which is Tier 1 only (layout.js).
  let mv = u.mv * vec4f(iPos, 1.0);
  var quad = g * vec2f(size, size * u.aspect);

  if (u.stretch > 0.0) {
    // Stretch along the velocity as the camera sees it. THE BASIS MUST STAY
    // RIGHT-HANDED — det([side, fwd]) = +1 — or every stretched quad is
    // mirrored, turns back-facing and is silently culled.
    let vv = (u.mv * vec4f(iPos + iVel * u.stretch, 1.0)).xyz - mv.xyz;
    let len = length(vv.xy);
    if (len > 1e-4) {
      let fwd = -vv.xy / len;
      let side = vec2f(fwd.y, -fwd.x);
      quad = side * (g.x * size) + fwd * (g.y * (size + len));
    }
  }

  var o: VO;
  o.pos = u.proj * vec4f(mv.xy + quad, mv.z, mv.w);
  o.uv = g + vec2f(0.5, 0.5);
  o.lifeT = lifeT;
  o.kill = iKillAlpha;
  o.color = iColor;
  o.speedT = iSpeedT;
  // Twinkle is a per-particle sine on its OWN age and phase.
  o.alphaMul = 1.0 - u.twinkle * 0.5
    * (1.0 + sin(iJitter.y + iAge * (5.0 + (iJitter.y % 7.0))));
  return o;
}

/* ── Sprite SDFs — transcribed, not re-derived ────────────────────────────── */

fn softDisc(p: vec2f) -> f32 {
  let t = clamp(1.0 - length(p), 0.0, 1.0);
  return t * t * (0.45 + 0.55 * t * t);
}

fn star(p: vec2f) -> f32 {
  let r = length(p);
  let core = pow(max(0.0, 1.0 - r), 5.0);
  let sx = pow(max(0.0, 1.0 - abs(p.x) * 7.0), 1.5) * pow(max(0.0, 1.0 - abs(p.y)), 2.5);
  let sy = pow(max(0.0, 1.0 - abs(p.y) * 7.0), 1.5) * pow(max(0.0, 1.0 - abs(p.x)), 2.5);
  let d = vec2f(p.x + p.y, p.x - p.y) * 0.7071;
  let dx = pow(max(0.0, 1.0 - abs(d.x) * 14.0), 1.5) * pow(max(0.0, 1.0 - abs(d.y) * 2.2), 2.5);
  let dy = pow(max(0.0, 1.0 - abs(d.y) * 14.0), 1.5) * pow(max(0.0, 1.0 - abs(d.x) * 2.2), 2.5);
  return clamp(core + (sx + sy) * 0.85 + (dx + dy) * 0.4, 0.0, 1.0);
}

fn spark(p: vec2f) -> f32 {
  let body = pow(max(0.0, 1.0 - length(vec2f(p.x * 3.2, p.y))), 2.0);
  let head = pow(max(0.0, 1.0 - length(vec2f(p.x * 2.2, (p.y + 0.55) * 1.6)) * 2.2), 2.0);
  return clamp(body * 0.75 + head, 0.0, 1.0);
}

@fragment
fn fs(i: VO) -> @location(0) vec4f {
  let c = textureSampleLevel(ramp, samp, vec2f(i.lifeT, 0.5), 0.0);
  var rgb = c.rgb;
  var a = 0.0;

  // uUseMap is a uniform, so this branch is uniform across the draw — which is
  // the condition WGSL actually requires for implicit-LOD sampling.
  if (u.useMap > 0.5) {
    // A layer object: the artwork IS the sprite.
    let art = textureSampleLevel(artMap, samp, i.uv, 0.0);
    if (art.a <= 0.004) { discard; }
    rgb = select(art.rgb, art.rgb * c.rgb, u.tint > 0.5);
    // The edge-on dimming a tumbling card needs is squash-driven, and squash is
    // fixed at 1 here (object mode is Tier 1), so the term is exactly 1.
    a = art.a * c.a * u.opacity * i.alphaMul * i.kill;
  } else {
    let p = (i.uv - vec2f(0.5)) * 2.0;
    var shape = 0.0;
    if (u.sprite == 1.0) { shape = star(p); }
    else if (u.sprite == 2.0) { shape = spark(p); }
    else { shape = softDisc(p); }
    if (shape <= 0.002) { discard; }
    // RGB comes from the ramp (age), the emitted pixel, or the velocity
    // gradient. ALPHA stays the life ramp in every case.
    rgb = mix(c.rgb, i.color, u.colorFromSource);
    rgb = mix(rgb, textureSampleLevel(ramp2, samp, vec2f(i.speedT, 0.5), 0.0).rgb, u.colorFromSpeed);
    a = c.a * shape * u.opacity * i.alphaMul * i.kill;
  }

  a = clamp(a, 0.0, 1.0);
  if (a <= 0.002) { discard; }

  // Premultiplied out, matching every other compositor layer.
  return vec4f(rgb * a, a);
}
`;
