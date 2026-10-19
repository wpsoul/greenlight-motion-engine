/*
 * TSL twin of doubleExposureEffect.js (the GLSL is the reference; keep the two
 * in lockstep). One main pass: `uTexture` = this layer's plate, `uTexture1` =
 * the referenced texture layer's quad plate — both plain samplers on both
 * backends (PORTING-GUIDE §3: a quad-written plate needs no flip).
 *
 * The fade edge reads the layer box through `fxLocal`, NOT `fxGeoLocal`: the
 * box axes are authored in uvn's own space, so fxLocal already lands on the
 * same side as GLSL's y-up fxLocal (measured — fxGeoLocal mirrored the fade
 * on WebGPU, tests/double-exposure/verify_render.js "fade -90°" caught it).
 * 90° fades toward the bottom of the layer on both backends.
 *
 * Helpers below are laid-out Fns that close over NOTHING but their inputs
 * (PORTING-GUIDE §7b); the body itself stays a closure because it reads the
 * material's uniforms.
 */
import {
  Fn, vec2, vec3, vec4, float,
  mix, clamp, abs, max, min, dot, cos, sin, smoothstep, step, select,
} from 'three/tsl';

const luma = Fn(([c]) => dot(c, vec3(0.2126, 0.7152, 0.0722)))
  .setLayout({ name: 'dxLuma', type: 'float', inputs: [{ name: 'c', type: 'vec3' }] });
const unpremult = Fn(([c]) => c.rgb.div(max(c.a, 1e-4)))
  .setLayout({ name: 'dxUnpremult', type: 'vec3', inputs: [{ name: 'c', type: 'vec4' }] });

// Photoshop clipColor: keep hue/sat, pin luma back into gamut. n/x are taken
// from the INPUT like the GLSL (both fixes use the same l, n, x).
const clipColor = Fn(([cIn]) => {
  const c = cIn.toVar();
  const l = luma(cIn).toVar();
  const n = min(cIn.r, min(cIn.g, cIn.b)).toVar();
  const x = max(cIn.r, max(cIn.g, cIn.b)).toVar();
  c.assign(select(n.lessThan(0.0), vec3(l).add(c.sub(vec3(l)).mul(l).div(max(l.sub(n), 1e-5))), c));
  c.assign(select(x.greaterThan(1.0), vec3(l).add(c.sub(vec3(l)).mul(float(1.0).sub(l)).div(max(x.sub(l), 1e-5))), c));
  return c;
}).setLayout({ name: 'dxClipColor', type: 'vec3', inputs: [{ name: 'cIn', type: 'vec3' }] });

// b = this layer (backdrop), s = the texture (source). Same ladder as the GLSL.
const blend = Fn(([m, b, s]) => {
  const one = vec3(1.0);
  const screen = one.sub(one.sub(b).mul(one.sub(s)));
  const lighten = max(b, s);
  const add = min(b.add(s), one);
  const multiply = b.mul(s);
  const darken = min(b, s);
  const overlay = mix(b.mul(s).mul(2.0), one.sub(one.sub(b).mul(one.sub(s)).mul(2.0)), step(vec3(0.5), b));
  const softLight = one.sub(s.mul(2.0)).mul(b).mul(b).add(s.mul(2.0).mul(b));
  const hardLight = mix(b.mul(s).mul(2.0), one.sub(one.sub(b).mul(one.sub(s)).mul(2.0)), step(vec3(0.5), s));
  const difference = abs(b.sub(s));
  const exclusion = b.add(s).sub(b.mul(s).mul(2.0));
  const dodge = min(b.div(max(one.sub(s), vec3(1e-3))), one);
  const burn = one.sub(min(one.sub(b).div(max(s, vec3(1e-3))), one));
  const luminosity = clipColor(b.add(vec3(luma(s).sub(luma(b)))));
  const color = clipColor(s.add(vec3(luma(b).sub(luma(s)))));
  return select(m.lessThan(0.5), s,
    select(m.lessThan(1.5), screen,
      select(m.lessThan(2.5), lighten,
        select(m.lessThan(3.5), add,
          select(m.lessThan(4.5), multiply,
            select(m.lessThan(5.5), darken,
              select(m.lessThan(6.5), overlay,
                select(m.lessThan(7.5), softLight,
                  select(m.lessThan(8.5), hardLight,
                    select(m.lessThan(9.5), difference,
                      select(m.lessThan(10.5), exclusion,
                        select(m.lessThan(11.5), dodge,
                          select(m.lessThan(12.5), burn,
                            select(m.lessThan(13.5), luminosity, color))))))))))))));
}).setLayout({
  name: 'dxBlend', type: 'vec3',
  inputs: [{ name: 'm', type: 'float' }, { name: 'b', type: 'vec3' }, { name: 's', type: 'vec3' }],
});

export const DOUBLE_EXPOSURE_PASS_BODIES = {
  'doubleExposure:main': ({ u, uvn, helpers }) => {
    const P = (i) => u.uParams.element(i);
    const src = u.uTexture.sample(uvn).toVar();
    const tex = u.uTexture1.sample(uvn).toVar();
    const blendMode = P(0), region = P(1), tones = P(2), sil = P(3);
    const keyThr = P(4).div(100.0), keySoft = max(P(5).div(100.0), 0.002);
    const subjDesat = P(6).div(100.0);
    const texContrast = P(7).div(100.0), texBright = P(8).div(100.0), texDesat = P(9).div(100.0);
    const fadeMode = P(10), fadeAngle = P(11).mul(0.017453292);
    const fadePos = P(12).div(100.0), fadeWidth = max(P(13).div(100.0), 0.002);
    const duo = P(14).div(100.0);

    // silhouette: this layer's alpha, or a luma key cut from its picture
    const s0 = clamp(unpremult(src), 0.0, 1.0).toVar();
    const sa = src.a;
    const k = smoothstep(keyThr.sub(keySoft), keyThr.add(keySoft), luma(s0));
    const keyed = select(sil.lessThan(1.5), k, float(1.0).sub(k)).mul(sa);
    const m = select(sil.greaterThan(0.5), keyed, sa).toVar();
    const s = mix(s0, vec3(luma(s0)), subjDesat).toVar();

    // texture: the referenced layer's plate, graded
    const b0 = clamp(unpremult(tex), 0.0, 1.0);
    const b1 = b0.sub(0.5).mul(texContrast).add(0.5).add(texBright).toVar();
    const b = clamp(mix(b1, vec3(luma(b1)), texDesat), 0.0, 1.0).toVar();

    // fade edge across the layer's box (centred, height = 1)
    const lp = helpers.fxLocal(uvn);
    const c = lp.sub(0.5).mul(vec2(helpers.fxAspect(), 1.0));
    const fp = dot(c, vec2(cos(fadeAngle), sin(fadeAngle).negate()));
    const ramp = float(1.0).sub(smoothstep(fadePos.sub(fadeWidth.mul(0.5)), fadePos.add(fadeWidth.mul(0.5)), fp));
    const fade = select(fadeMode.lessThan(0.5), float(1.0), ramp).toVar();

    // where the texture is allowed
    const gate = select(region.lessThan(0.5), m, select(region.lessThan(1.5), float(1.0), float(1.0).sub(m)));
    const tone0 = select(tones.lessThan(0.5), float(1.0), select(tones.lessThan(1.5), float(1.0).sub(luma(s)), luma(s)));
    const tone = mix(float(1.0), tone0, m);
    const fadeTex = select(fadeMode.lessThan(0.5), float(1.0), select(fadeMode.lessThan(1.5), fade, float(1.0)));
    const w = tex.a.mul(gate).mul(tone).mul(fadeTex).toVar();

    // composite: texture (w) with blend mode over this layer (m)
    const blended = clamp(blend(blendMode, s, b), 0.0, 1.0);
    const rgb0 = float(1.0).sub(m).mul(w).mul(b)
      .add(float(1.0).sub(w).mul(m).mul(s))
      .add(w.mul(m).mul(blended));
    const a0 = w.add(m.mul(float(1.0).sub(w)));
    const both = fadeMode.greaterThan(1.5);
    const rgb = select(both, rgb0.mul(fade), rgb0).toVar();
    const a = select(both, a0.mul(fade), a0).toVar();

    // duotone on the finished plate
    const col = rgb.div(max(a, 1e-4));
    const shadow = vec3(u.uColors.element(0), u.uColors.element(1), u.uColors.element(2));
    const high = vec3(u.uColors.element(3), u.uColors.element(4), u.uColors.element(5));
    const duoCol = clamp(mix(col, mix(shadow, high, luma(col)), duo), 0.0, 1.0).mul(a);
    const rgbOut = select(duo.greaterThan(0.001), duoCol, rgb);
    return vec4(rgbOut, clamp(a, 0.0, 1.0));
  },
};
