/*
 * TSL twin of glassEffect.js:  createGlassNodeMaterial() ← createGlassMaterial()
 *
 * Same maths, same uniform names (setGlassUniforms drives both). What differs,
 * and why:
 *
 * - ORIENTATION. The stack is read at screenCoordinate / uResolution, the
 *   storage-identity read (PORTING-GUIDE §3.6) — as Backdrop Blur's mix does.
 *   screenCoordinate is TOP-down on WebGPU, so the pixel's NDC is
 *   (2u − 1, 1 − 2v) and a projected point lands at v = 0.5 − ndc.y / 2. The
 *   driver hands uBounds in the same top-down v (computeGlassFrame flipV) and
 *   the clip depth range as [0, 1] (uNdcZ), which is WebGPU's. The Layer
 *   Mask's box map takes frame uv y UP (computeLayerBox), so the pixel's is
 *   (u, 1 − v); its plate is a canvas texture, read unflipped (layerMaskNodes).
 * - SAMPLING UNDER PER-PIXEL BRANCHES. WGSL forbids implicit-LOD sampling in
 *   non-uniform control flow, and almost every read here sits under the
 *   coverage / march / bounds branches — so every read is an explicit level-0
 *   sample (`.level(0)`); the targets carry no mips, so it is the same texel.
 *   fwidth() is taken at the top, before any branch.
 * - LAYOUTS. Pure helpers (outline, height profile, surface, noise, studio
 *   environment) are laid out and take every value as a parameter; helpers
 *   that read a uniform stay inline (§2: a laid-out helper that closes over a
 *   uniform captures its slot before the struct is numbered → black frame).
 * - Enum uniforms (shape kind, profile, surface) are floats compared against
 *   half-steps, so no int/float mixing reaches WGSL.
 */
import * as THREE from 'three/webgpu';
import {
  Fn, If, Loop, Break, uniform, uniformArray, vec2, vec3, vec4, float, int,
  abs, max, min, clamp, mix, smoothstep, sqrt, pow, exp, length, normalize, dot, cross,
  fract, floor, sin, cos, reflect, refract, fwidth, select, screenCoordinate,
} from 'three/tsl';
import { makeTslSampler } from './tslSampler.js';

const LUMA = vec3(0.2126, 0.7152, 0.0722);

// ── pure helpers (laid out) ─────────────────────────────────────────────────
const hash22 = Fn(([p]) => {
  const a = fract(vec3(p.x, p.y, p.x).mul(vec3(0.1031, 0.1030, 0.0973))).toVar();
  a.addAssign(dot(a, a.yzx.add(33.33)));
  return fract(vec2(a.x, a.x).add(a.yz).mul(a.zy));
}).setLayout({ name: 'glHash22', type: 'vec2', inputs: [{ name: 'p', type: 'vec2' }] });

const hash12 = Fn(([p]) => {
  const a = fract(vec3(p.x, p.y, p.x).mul(0.1031)).toVar();
  a.addAssign(dot(a, a.yzx.add(33.33)));
  return fract(a.x.add(a.y).mul(a.z));
}).setLayout({ name: 'glHash12', type: 'float', inputs: [{ name: 'p', type: 'vec2' }] });

const vnoise = Fn(([p]) => {
  const i = floor(p);
  const f = fract(p);
  const w = f.mul(f).mul(vec2(3.0).sub(f.mul(2.0)));
  return mix(
    mix(hash12(i), hash12(i.add(vec2(1.0, 0.0))), w.x),
    mix(hash12(i.add(vec2(0.0, 1.0))), hash12(i.add(vec2(1.0, 1.0))), w.x),
    w.y,
  );
}).setLayout({ name: 'glVnoise', type: 'float', inputs: [{ name: 'p', type: 'vec2' }] });

// The outline's signed distance: kind 0 = rounded box (radii TL, TR, BR, BL; local y up), 1 = ellipse.
const sdShapeL = Fn(([p, kind, half, radii, cornerN]) => {
  const out = float(0.0).toVar();
  If(kind.greaterThan(0.5), () => {
    const k0 = length(p.div(half));
    const k1 = length(p.div(half.mul(half)));
    out.assign(k0.mul(k0.sub(1.0)).div(max(k1, 1e-6)));
  }).Else(() => {
    const rr = select(p.x.greaterThan(0.0), select(p.y.greaterThan(0.0), radii.y, radii.z), select(p.y.greaterThan(0.0), radii.x, radii.w));
    const r = min(rr, min(half.x, half.y)).toVar();
    const q = abs(p).sub(half).add(r).toVar();
    const m = max(q, vec2(0.0)).toVar();
    const c = length(m).toVar();
    If(cornerN.greaterThan(2.01).and(r.greaterThan(0.5)), () => {
      const mn = pow(m.div(r), vec2(cornerN));
      c.assign(r.mul(pow(mn.x.add(mn.y), float(1.0).div(cornerN))));
    });
    out.assign(c.add(min(max(q.x, q.y), 0.0)).sub(r));
  });
  return out;
}).setLayout({
  name: 'glSdShape', type: 'float',
  inputs: [{ name: 'p', type: 'vec2' }, { name: 'kind', type: 'float' }, { name: 'half', type: 'vec2' }, { name: 'radii', type: 'vec4' }, { name: 'cornerN', type: 'float' }],
});

// Macro height above the lowest bevel point (0 at the rim; `thick` on the plateau or at the lens centre / rim).
const macroHL = Fn(([p, d, half, lensM, profile, bevel, thick]) => {
  const x = d.negate();
  const out = float(0.0).toVar();
  If(x.greaterThan(0.0), () => {
    If(profile.greaterThan(2.5), () => {
      const r2 = float(0.0).toVar();
      If(lensM.lessThan(0.0), () => {
        const r = float(1.0).sub(min(x.div(min(half.x, half.y)), 1.0));
        r2.assign(r.mul(r));
      }).Else(() => {
        const a = p.div(half.mul(lensM));
        r2.assign(min(dot(a, a), 1.0));
      });
      const dome = profile.lessThan(3.5);
      const h = select(dome, float(1.0).sub(r2), r2);
      const rt = clamp(x.div(max(bevel, 1.0)), 0.0, 1.0);
      const cap = sqrt(float(1.0).sub(float(1.0).sub(rt).mul(float(1.0).sub(rt))));
      out.assign(thick.mul(select(dome, h, h.mul(0.85).add(0.15).mul(cap))));
    }).Else(() => {
      const t = clamp(x.div(max(bevel, 0.5)), 0.0, 1.0);
      const u = float(1.0).sub(t);
      const hCircle = sqrt(max(float(1.0).sub(u.mul(u)), 0.0));
      const hSquircle = pow(max(float(1.0).sub(u.mul(u).mul(u).mul(u)), 0.0), 0.25);
      const h = select(profile.lessThan(0.5), hCircle, select(profile.lessThan(1.5), hSquircle, t));
      out.assign(thick.mul(h));
    });
  });
  return out;
}).setLayout({
  name: 'glMacroH', type: 'float',
  inputs: [{ name: 'p', type: 'vec2' }, { name: 'd', type: 'float' }, { name: 'half', type: 'vec2' }, { name: 'lensM', type: 'float' },
    { name: 'profile', type: 'float' }, { name: 'bevel', type: 'float' }, { name: 'thick', type: 'float' }],
});

const surfHL = Fn(([p, surface, scale, depth, angle]) => {
  const out = float(0.0).toVar();
  If(surface.greaterThan(0.5), () => {
    const ca = cos(angle);
    const sa = sin(angle);
    const r = vec2(ca.mul(p.x).add(sa.mul(p.y)), sa.negate().mul(p.x).add(ca.mul(p.y))).div(scale).toVar();
    If(surface.lessThan(1.5), () => {
      const f = fract(r.x).mul(2.0).sub(1.0);
      out.assign(depth.mul(float(1.0).sub(f.mul(f))));
    }).ElseIf(surface.lessThan(2.5), () => {
      const i = floor(r);
      const fr = fract(r);
      const d1 = float(9.0).toVar();
      Loop({ start: int(-1), end: int(2), type: 'int', name: 'gy' }, ({ gy }) => {
        Loop({ start: int(-1), end: int(2), type: 'int', name: 'gx' }, ({ gx }) => {
          const g = vec2(float(gx), float(gy));
          const hh = hash22(i.add(g)).mul(0.7).add(0.15);
          const dd = length(g.add(hh).sub(fr));
          const blend = max(float(0.18).sub(abs(d1.sub(dd))), 0.0).div(0.18);
          d1.assign(min(d1, dd).sub(blend.mul(blend).mul(0.045)));
        });
      });
      out.assign(depth.mul(d1).mul(d1).mul(1.6));
    }).Else(() => {
      const n = vnoise(r).mul(0.65).add(vnoise(r.mul(2.1).add(7.3)).mul(0.35));
      out.assign(depth.mul(n));
    });
  });
  return out;
}).setLayout({
  name: 'glSurfH', type: 'float',
  inputs: [{ name: 'p', type: 'vec2' }, { name: 'surface', type: 'float' }, { name: 'scale', type: 'float' }, { name: 'depth', type: 'float' }, { name: 'angle', type: 'float' }],
});

// The studio the glass reflects, in VIEW space (y up, z toward the viewer).
const envColorL = Fn(([r, light, rough]) => {
  const up = r.y;
  const sky = vec3(1.0);
  const hor = vec3(0.80, 0.81, 0.84);
  const gnd = vec3(0.34, 0.35, 0.37);
  const c = select(up.greaterThan(0.0), mix(hor, sky, smoothstep(0.0, 0.65, up)), mix(hor, gnd, smoothstep(0.0, 0.55, up.negate()))).toVar();
  const k = dot(r, light);
  const softness = rough.mul(0.22);
  c.addAssign(smoothstep(float(0.82).sub(softness), 0.97, k).mul(float(1.0).sub(rough.mul(0.55))));
  const axis = normalize(vec3(0.85, 0.25, 0.45));
  const across = normalize(cross(axis, vec3(0.0, 1.0, 0.0)));
  const along = cross(across, axis);
  const strip = float(1.0).sub(smoothstep(0.035, softness.add(0.10), abs(dot(r, across))))
    .mul(float(1.0).sub(smoothstep(0.28, softness.add(0.65), abs(dot(r, along)))));
  c.addAssign(strip.mul(smoothstep(0.4, 0.8, dot(r, axis))).mul(float(0.75).sub(rough.mul(0.4))));
  return c;
}).setLayout({
  name: 'glEnv', type: 'vec3',
  inputs: [{ name: 'r', type: 'vec3' }, { name: 'light', type: 'vec3' }, { name: 'rough', type: 'float' }],
});

export function createGlassNodeMaterial() {
  const u = {
    uStack: makeTslSampler({ rgba: [0, 0, 0, 0] }),
    uBlur: makeTslSampler({ rgba: [0, 0, 0, 0] }),
    uResolution: uniform(new THREE.Vector2(1, 1)),
    uBounds: uniform(new THREE.Vector4(0, 0, 1, 1)),
    uLocalToClip: uniform(new THREE.Matrix4()),
    uClipToLocal: uniform(new THREE.Matrix4()),
    uLocalToView: uniform(new THREE.Matrix3()),
    uLightLocal: uniform(new THREE.Vector3(0, 0, 1)),
    uLightView: uniform(new THREE.Vector3(0, 0, 1)),
    uShadowDir: uniform(new THREE.Vector2(0, -1)),
    uNdcZ: uniform(new THREE.Vector2(0, 1)),
    uMarch: uniform(0),
    uShapeKind: uniform(0),
    uHalf: uniform(new THREE.Vector2(1, 1)),
    uRadii: uniform(new THREE.Vector4()),
    uCornerN: uniform(2),
    uLensM: uniform(-1),
    uProfile: uniform(1),
    uBevel: uniform(1),
    uThick: uniform(0),
    uBody: uniform(0),
    uIor: uniform(1.5),
    uDisp: uniform(0),
    uMagnify: uniform(1),
    uFrost: uniform(0),
    uGrain: uniform(0),
    uFrostEdge: uniform(0),
    uSurface: uniform(0),
    uSurfScale: uniform(20),
    uSurfDepth: uniform(0),
    uSurfAngle: uniform(0),
    uTint: uniform(new THREE.Vector3(1, 1, 1)),
    uTintAmt: uniform(0),
    uAbsorption: uniform(0),
    uMilk: uniform(0),
    uSat: uniform(1),
    uBright: uniform(0),
    uEdge: uniform(0),
    uSpec: uniform(0),
    uShine: uniform(90),
    uRim: uniform(0),
    uRimWidth: uniform(2),
    uRefl: uniform(0),
    uRoughness: uniform(0),
    uShadow: uniform(new THREE.Vector3(0, 1, 0)),
    uGuard: uniformArray(new Array(64).fill(1), 'float'),
    uOpacity: uniform(1),
    uMatte: makeTslSampler({ rgba: [0, 0, 0, 0] }),
    uMatteOn: uniform(0),
    uMatteLuma: uniform(0),
    uMatteInvert: uniform(0),
    // Layer Mask: this frame's cut (see glassEffect.js). White fallback — a multiplier.
    uLMask: makeTslSampler({ rgba: [255, 255, 255, 255] }),
    uLMaskHomInv: uniform(new THREE.Matrix3()),
    uLMaskOn: uniform(0),
    uLMaskAmount: uniform(1),
  };

  // ── uniform-reading helpers (inline) ──
  const sdShape = (p) => sdShapeL(p, u.uShapeKind, u.uHalf, u.uRadii, u.uCornerN);
  const macroH = (p, d) => macroHL(p, d, u.uHalf, u.uLensM, u.uProfile, u.uBevel, u.uThick);
  const fullH = (p) => {
    const d = sdShape(p);
    return macroH(p, d).add(surfHL(p, u.uSurface, u.uSurfScale, u.uSurfDepth, u.uSurfAngle).mul(smoothstep(0.0, 3.0, d.negate())));
  };
  const heightNormal = (p) => {
    const e = 0.75;
    const hx = fullH(p.add(vec2(e, 0.0))).sub(fullH(p.sub(vec2(e, 0.0))));
    const hy = fullH(p.add(vec2(0.0, e))).sub(fullH(p.sub(vec2(0.0, e))));
    return normalize(vec3(hx.negate().div(2 * e), hy.negate().div(2 * e), 1.0));
  };
  const macroNormal = (p) => {
    const e = 0.75;
    const mh = (q) => macroH(q, sdShape(q));
    const hx = mh(p.add(vec2(e, 0.0))).sub(mh(p.sub(vec2(e, 0.0))));
    const hy = mh(p.add(vec2(0.0, e))).sub(mh(p.sub(vec2(0.0, e))));
    return normalize(vec3(hx.negate().div(2 * e), hy.negate().div(2 * e), 1.0));
  };
  const sdGrad = (p) => {
    const e = 0.5;
    return normalize(vec2(
      sdShape(p.add(vec2(e, 0.0))).sub(sdShape(p.sub(vec2(e, 0.0)))),
      sdShape(p.add(vec2(0.0, e))).sub(sdShape(p.sub(vec2(0.0, e)))),
    ).add(1e-6));
  };
  const zBottom = () => u.uThick.add(u.uBody).negate();
  const shadowAt = (p) => {
    const d = sdShape(p.sub(u.uShadowDir.mul(u.uShadow.z)));
    const s = u.uShadow.x.div(exp(d.mul(1.8).div(max(u.uShadow.y, 1.0))).add(1.0));
    return select(u.uShadow.x.greaterThan(0.0), s, float(0.0));
  };
  const shadowOver = (c, s) => vec4(c.rgb.mul(float(1.0).sub(s)), c.a.mul(float(1.0).sub(s)).add(s));
  // Layer Mask coverage at a frame uv (y up, computeLayerBox's convention) —
  // layerMaskNodes' coverageAt read: the plate is a canvas texture, read UNFLIPPED
  // on both backends; explicit level 0 because every call sits under a branch.
  // Callers gate on uLMaskOn, so an unmasked pane never samples.
  const layerMaskAt = (f) => {
    const h = u.uLMaskHomInv.mul(vec3(f.x, f.y, 1.0)).toVar();
    const p = select(h.z.lessThan(1e-6), vec2(-1e3, -1e3), h.xy.div(max(h.z, 1e-6))).toVar();
    const outside = p.x.lessThan(0.0).or(p.x.greaterThan(1.0)).or(p.y.lessThan(0.0)).or(p.y.greaterThan(1.0));
    const c = select(outside, float(0.0), u.uLMask.sample(p).level(0).a);
    return clamp(mix(float(1.0), c, clamp(u.uLMaskAmount, 0.0, 1.0)), 0.0, 1.0);
  };
  // A point on the layer plane (local px, z = 0) → frame uv, y up.
  const frameUV = (l) => {
    const c = u.uLocalToClip.mul(vec4(l.x, l.y, 0.0, 1.0));
    return c.xy.div(max(c.w, 1e-5)).mul(0.5).add(0.5);
  };
  // The mask where the shadow's occluder sits, softened across the shadow blur.
  const shadowMaskAt = (p) => {
    const o = p.sub(u.uShadowDir.mul(u.uShadow.z)).toVar();
    const r = max(u.uShadow.y, 1.0).mul(0.6).toVar();
    return layerMaskAt(frameUV(o))
      .add(layerMaskAt(frameUV(o.add(vec2(r, 0.0))))).add(layerMaskAt(frameUV(o.sub(vec2(r, 0.0)))))
      .add(layerMaskAt(frameUV(o.add(vec2(0.0, r))))).add(layerMaskAt(frameUV(o.sub(vec2(0.0, r)))))
      .mul(0.2);
  };

  const material = new THREE.MeshBasicNodeMaterial();
  material.fragmentNode = Fn(() => {
    const uvPix = screenCoordinate.xy.div(u.uResolution).toVar();
    const ndc = vec2(uvPix.x.mul(2.0).sub(1.0), float(1.0).sub(uvPix.y.mul(2.0)));
    const h0 = u.uClipToLocal.mul(vec4(ndc, u.uNdcZ.x, 1.0)).toVar();
    const h1 = u.uClipToLocal.mul(vec4(ndc, u.uNdcZ.y, 1.0)).toVar();
    const ol = h0.xyz.div(h0.w).toVar();
    const dl = normalize(h1.xyz.div(h1.w).sub(ol)).toVar();
    const side = float(1.0).toVar();
    If(dl.z.greaterThan(0.0), () => {
      ol.assign(vec3(ol.x, ol.y, ol.z.negate()));
      dl.assign(vec3(dl.x, dl.y, dl.z.negate()));
      side.assign(-1.0);
    });
    dl.assign(vec3(dl.x, dl.y, min(dl.z, -1e-4)));
    const q0 = ol.add(dl.mul(ol.z.negate().div(dl.z))).toVar();
    const zb = zBottom().toVar();
    const q1 = ol.add(dl.mul(zb.sub(ol.z).div(dl.z))).toVar();
    const sd0 = sdShape(q0.xy).toVar();
    // derivatives in uniform control flow, before any branch
    const fw = max(fwidth(sd0), 1e-3).toVar();
    const pxl = max(length(fwidth(q0.xy)).mul(0.7071), 1e-3).toVar();
    const stackPx = u.uStack.sample(uvPix).level(0).toVar();
    const flat = u.uMarch.lessThan(0.5);

    // A square-on pane: straight rays, landing on the pane's own plane (see glassEffect.js).
    const projectUV = (q) => {
      const c = u.uLocalToClip.mul(vec4(q.x, q.y, select(flat, float(0.0), q.z.mul(side)), 1.0));
      const n = c.xy.div(max(c.w, 1e-5));
      return vec2(n.x.mul(0.5).add(0.5), float(0.5).sub(n.y.mul(0.5)));
    };
    const dirToView = (v) => normalize(u.uLocalToView.mul(vec3(v.x, v.y, v.z.mul(side))));

    const result = vec4(stackPx).toVar();
    const inBounds = uvPix.x.greaterThanEqual(u.uBounds.x).and(uvPix.y.greaterThanEqual(u.uBounds.y))
      .and(uvPix.x.lessThanEqual(u.uBounds.z)).and(uvPix.y.lessThanEqual(u.uBounds.w));
    // How much of the pane this pixel keeps: opacity × track matte (camera-axis,
    // read at the pixel like the stack). Sampled here, before any branch.
    const ms = u.uMatte.sample(uvPix).level(0);
    const mv = mix(ms.a, dot(ms.rgb, vec3(0.299, 0.587, 0.114)), u.uMatteLuma);
    const keep = u.uOpacity.mul(select(u.uMatteOn.greaterThan(0.5), mix(mv, float(1.0).sub(mv), u.uMatteInvert), float(1.0))).toVar();
    If(inBounds.and(keep.greaterThan(0.0)), () => {
      // The Layer Mask cuts the pane where this pixel sees it, and the shadow where
      // its occluder sits. A cut-away pixel shows the stack (with whatever shadow
      // the kept part throws on it) and skips the shading entirely.
      const frameF = vec2(uvPix.x, float(1.0).sub(uvPix.y));
      const lmPane = float(1.0).toVar();
      const lmShade = float(1.0).toVar();
      If(u.uLMaskOn.greaterThan(0.5), () => {
        lmPane.assign(layerMaskAt(frameF));
        If(u.uShadow.x.greaterThan(0.0), () => { lmShade.assign(shadowMaskAt(q1.xy)); });
      });
      const outside = mix(stackPx, shadowOver(stackPx, shadowAt(q1.xy)), keep.mul(lmShade)).toVar();
      result.assign(outside);
      If(lmPane.greaterThan(0.0), () => {
        const I = select(flat, vec3(0.0, 0.0, -1.0), dl).toVar();
        const w = vec3(0.0).toVar();
        const N = vec3(0.0, 0.0, 1.0).toVar();
        const sideHit = float(0.0).toVar();
        const cov = float(0.0).toVar();

        If(flat, () => {
          cov.assign(clamp(float(0.5).sub(sd0.div(fw)), 0.0, 1.0));
          const pin = q0.xy.toVar();
          If(sd0.greaterThan(-0.5), () => { pin.assign(pin.sub(sdGrad(pin).mul(sd0.add(0.5)))); });
          w.assign(vec3(pin, fullH(pin).sub(u.uThick)));
          N.assign(heightNormal(pin));
        }).Else(() => {
          const hit = float(0.0).toVar();
          const prev = vec3(q0).toVar();
          const hp = vec3(q0).toVar();
          const minG = float(1e9).toVar();
          const best = vec3(q0).toVar();
          Loop({ start: int(0), end: int(29), type: 'int', name: 'mi' }, ({ mi }) => {
            const p = mix(q0, q1, float(mi).div(28.0)).toVar();
            const sd = sdShape(p.xy).toVar();
            const surf = macroH(p.xy, sd).sub(u.uThick).toVar();
            const g = max(sd, p.z.sub(surf));
            If(g.lessThan(minG), () => { minG.assign(g); best.assign(p); });
            If(sd.lessThanEqual(0.0).and(p.z.lessThanEqual(surf)), () => {
              hit.assign(1.0);
              hp.assign(p);
              Break();
            });
            prev.assign(p);
          });
          If(hit.greaterThan(0.5), () => {
            const a = vec3(prev).toVar();
            const b = vec3(hp).toVar();
            Loop({ start: int(0), end: int(6), type: 'int', name: 'bi' }, () => {
              const m = a.add(b).mul(0.5).toVar();
              const sd = sdShape(m.xy);
              If(sd.lessThanEqual(0.0).and(m.z.lessThanEqual(macroH(m.xy, sd).sub(u.uThick))), () => { b.assign(m); })
                .Else(() => { a.assign(m); });
            });
            w.assign(b);
            cov.assign(1.0);
          }).Else(() => {
            w.assign(best);
            cov.assign(clamp(float(0.5).sub(minG.div(pxl)), 0.0, 1.0));
          });
          const sdm = sdShape(w.xy).toVar();
          sideHit.assign(select(w.z.lessThan(u.uThick.negate().sub(0.75)).and(u.uBody.greaterThan(0.5)), float(1.0), float(0.0)));
          If(sideHit.greaterThan(0.5), () => {
            N.assign(normalize(vec3(sdGrad(w.xy), 0.06)));
          }).Else(() => {
            const pin = w.xy.toVar();
            If(sdm.greaterThan(-0.5), () => { pin.assign(pin.sub(sdGrad(pin).mul(sdm.add(0.5)))); });
            N.assign(heightNormal(pin));
          });
        });

        If(cov.greaterThan(0.0), () => {
          const isSide = sideHit.greaterThan(0.5);
          const sdw = sdShape(w.xy).toVar();
          const xIn = max(sdw.negate(), 0.0).toVar();
          const hNbevel = clamp(macroH(w.xy, sdw).div(max(u.uThick, 1e-3)), 0.0, 1.0);
          const hNlin = clamp(xIn.div(max(u.uBevel, 1.0)), 0.0, 1.0);
          const hN = select(u.uProfile.greaterThan(2.5).or(u.uThick.lessThan(0.01)), hNlin, hNbevel).toVar();
          // fold guard
          const gf = clamp(xIn.div(max(u.uBevel, 0.5)), 0.0, 1.0).mul(63.0).toVar();
          const gi = int(floor(gf)).toVar();
          const gj = min(gi.add(1), int(63));
          const guard = select(isSide, float(1.0), mix(u.uGuard.element(gi), u.uGuard.element(gj), gf.sub(float(gi)))).toVar();
          const frostMask = select(u.uFrostEdge.greaterThan(0.5), smoothstep(u.uFrostEdge.sub(0.75), u.uFrostEdge.add(0.75), xIn), float(1.0)).toVar();
          const Nm = vec3(N).toVar();
          If(isSide.not().and(u.uSurface.greaterThan(0.5)), () => {
            Nm.assign(macroNormal(w.xy.sub(sdGrad(w.xy).mul(max(sdw.add(0.5), 0.0)))));
          });

          const backdrop = (e) => {
            const ex = e.xy.div(u.uMagnify).toVar();
            const suv = projectUV(vec3(ex, e.z)).toVar();
            If(u.uGrain.greaterThan(0.0).and(frostMask.greaterThan(0.0)), () => {
              suv.addAssign(hash22(floor(ex)).sub(0.5).mul(u.uGrain).mul(frostMask).mul(9.0).div(u.uResolution));
            });
            const c = u.uStack.sample(suv).level(0).toVar();
            If(u.uFrost.greaterThan(0.0), () => { c.assign(mix(c, u.uBlur.sample(suv).level(0), u.uFrost.mul(frostMask))); });
            return shadowOver(c, shadowAt(ex).mul(0.5));
          };
          const refractTo = (ior) => {
            const R = refract(I, N, float(1.0).div(ior)).toVar();
            If(dot(R, R).lessThan(1e-6), () => { R.assign(reflect(I, N)); });
            const dz = max(w.z.sub(zb), 0.0);
            const straight = I.mul(dz.div(I.z.negate()));
            const bent = R.mul(dz.div(max(R.z.negate(), 0.25)));
            return backdrop(w.add(straight).add(bent.sub(straight).mul(guard)));
          };

          const col = vec4(0.0).toVar();
          If(u.uDisp.greaterThan(0.001), () => {
            const acc = vec3(0.0).toVar();
            const accA = float(0.0).toVar();
            Loop({ start: int(0), end: int(5), type: 'int', name: 'di' }, ({ di }) => {
              const f = float(di).mul(0.25);
              const wt = max(vec3(float(1.0).sub(abs(f).mul(2.0)), float(1.0).sub(abs(f.sub(0.5)).mul(2.0)), float(1.0).sub(abs(f.sub(1.0)).mul(2.0))), vec3(0.0));
              const s = refractTo(max(float(1.0), u.uIor.add(f.sub(0.5).mul(u.uDisp).mul(0.7)))).toVar();
              acc.addAssign(wt.mul(s.rgb));
              accA.addAssign(s.a.mul(wt.x.add(wt.y).add(wt.z)));
            });
            col.assign(vec4(acc.div(vec3(1.5, 2.0, 1.5)), accA.div(5.0)));
          }).Else(() => {
            col.assign(refractTo(u.uIor));
          });

          const l = dot(col.rgb, LUMA);
          col.assign(vec4(clamp(mix(vec3(l), col.rgb, u.uSat).add(u.uBright.mul(col.a)), vec3(0.0), vec3(col.a)), col.a));
          const ray = refract(I, N, float(1.0).div(max(u.uIor, 1.0)));
          const depth = max(w.z.sub(zb), 0.0).div(max(u.uThick.add(u.uBody), 1.0));
          const path = depth.div(max(abs(ray.z), 0.25));
          const transmission = max(mix(vec3(1.0), u.uTint, u.uTintAmt), vec3(0.001));
          col.assign(vec4(col.rgb.mul(pow(transmission, vec3(u.uAbsorption.mul(path).mul(2.0).add(1.0)))), col.a));
          col.assign(mix(col, vec4(mix(vec3(1.0), u.uTint, 0.25), 1.0), u.uMilk));
          const rimT = float(1.0).sub(hN);
          col.assign(vec4(col.rgb.mul(float(1.0).sub(u.uEdge.mul(rimT).mul(rimT).mul(0.6))), col.a));
          If(isSide, () => {
            col.assign(vec4(mix(col.rgb, col.rgb.mul(mix(vec3(1.0), u.uTint, 0.6)).mul(0.82), 0.6), col.a));
          });

          const V = I.negate();
          const cosv = clamp(dot(N, V), 0.0, 1.0);
          const f0 = pow(u.uIor.sub(1.0).div(u.uIor.add(1.0)), 2.0);
          const F = f0.add(float(1.0).sub(f0).mul(pow(float(1.0).sub(cosv), 5.0))).toVar();
          const env = envColorL(dirToView(reflect(I, N)), u.uLightView, u.uRoughness);
          If(isSide, () => {
            F.mulAssign(0.4);
            col.addAssign(vec4(mix(vec3(1.0), u.uTint, 0.5).mul(0.06), 0.06));
          });
          col.assign(mix(col, vec4(env, 1.0), clamp(F.mul(u.uRefl), 0.0, 1.0)));

          const L = normalize(vec3(u.uLightLocal.x, u.uLightLocal.y, u.uLightLocal.z.mul(side))).toVar();
          const Hh = normalize(L.add(V));
          const shine = mix(u.uShine, 8.0, u.uRoughness.mul(u.uRoughness));
          const energy = shine.add(2.0).div(u.uShine.add(2.0));
          const sp = u.uSpec.mul(energy).mul(pow(max(dot(N, Hh), 0.0), shine));
          col.addAssign(vec4(vec3(1.0, 0.99, 0.97).mul(sp), sp));

          const slope = length(Nm.xy).toVar();
          If(slope.greaterThan(1e-3), () => {
            const nd = Nm.xy.div(slope);
            const ld = normalize(L.xy.add(1e-5));
            const f = dot(nd, ld);
            const band = exp(select(isSide, float(0.0), xIn).negate().div(max(u.uRimWidth, 0.3)));
            const rim = pow(max(f, 0.0), 2.0).add(pow(max(f.negate(), 0.0), 2.0).mul(0.30)).add(0.025);
            const rl = u.uRim.mul(band).mul(rim).mul(smoothstep(0.0, 0.35, slope)).mul(0.9);
            col.addAssign(vec4(vec3(rl), rl));
          });
          const a = clamp(col.a, 0.0, 1.0);
          const glass = vec4(clamp(col.rgb, vec3(0.0), vec3(a)), a);
          result.assign(mix(outside, mix(stackPx, glass, keep), cov.mul(lmPane)));
        });
      });
    });
    return result;
  })();
  material.depthTest = false;
  material.depthWrite = false;
  material.forceSinglePass = true;
  material.transparent = false;
  material.blending = THREE.NoBlending;
  material.uniforms = u;
  return material;
}
