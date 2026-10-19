/*
 * Double Exposure — another LAYER's picture living inside this layer's silhouette.
 * Ported from html/double-exposure-lab.html (tune there first). PRO.
 *
 * THE ONE IDEA
 * ------------
 * A double exposure is two images sharing one silhouette: this layer gives the
 * SHAPE (its alpha, or a luma key cut from it), the referenced layer gives the
 * CONTENT, and a blend mode decides how much of this layer's own shading
 * survives inside. The seam-hiding that reads as "the look" is a gradient FADE
 * across the layer's box and a duotone that glues two photographs into one plate.
 *
 * WHY THE TEXTURE IS A LAYER, NOT A FILE
 * --------------------------------------
 * The lab positions the texture with its own scale / offset / rotation / drift
 * sliders. In the editor every one of those is already a layer transform with
 * keyframes, and a video texture wants a trim, a speed and its own effects. So
 * the texture is a layer reference (`usesLayerRef`, the Copy Color Profile
 * mechanism): the Player pre-renders that layer's isolate — through its own
 * channel camera, with its own layer-effect stack — into a quad plate and hands
 * it to the main pass as `uTexture1`. Move the texture layer, and the texture
 * moves inside the silhouette. `consumesLayerRef` asks the compositor not to
 * draw the referenced layer on its own (a Track Matte source is hidden the same
 * way); its pixels exist only inside this layer.
 *
 * COMPOSITING
 * -----------
 * Everything is premultiplied in and out. Inside the silhouette the texture is
 * blended with this layer's colour (W3C compositing: (1-αb)·αs·Cs + (1-αs)·αb·Cb
 * + αs·αb·B(Cb,Cs)), where the texture's effective alpha is its plate alpha ×
 * the region gate (inside / whole frame / outside) × the tone weight × the fade.
 * "Whole frame" and "Outside" ADD coverage where this layer has none, which is
 * why the descriptor says `layerMatte: 'expand'` — clipping to the source alpha
 * would erase exactly the pixels those modes exist for.
 *
 * ORIENTATION
 * -----------
 * The fade edge lives in the layer's box (fxLocal), so it rides the layer. The
 * lab's screen-y-down angle convention is kept: 90° fades toward the bottom of
 * the layer. GLSL's fxLocal has +y up, so the direction is (cos a, −sin a); the
 * TSL twin reads the box through plain fxLocal (same orientation, measured —
 * fxGeoLocal mirrors it) so the same (cos a, −sin a) applies there.
 */

export const DOUBLE_EXPOSURE_ID = 'doubleExposure';

// Shared by the GLSL body below and documented in skills/greenlight-dash.
export const DOUBLE_EXPOSURE_BLENDS = [
  { value: 0, label: 'Normal' },
  { value: 1, label: 'Screen' },
  { value: 2, label: 'Lighten' },
  { value: 3, label: 'Add (Linear Dodge)' },
  { value: 4, label: 'Multiply' },
  { value: 5, label: 'Darken' },
  { value: 6, label: 'Overlay' },
  { value: 7, label: 'Soft Light' },
  { value: 8, label: 'Hard Light' },
  { value: 9, label: 'Difference' },
  { value: 10, label: 'Exclusion' },
  { value: 11, label: 'Color Dodge' },
  { value: 12, label: 'Color Burn' },
  { value: 13, label: 'Luminosity' },
  { value: 14, label: 'Color' },
];

const DX_MAIN_FX = /* glsl */ `
// Keep a colour's hue/sat while pinning its luma back into gamut (Photoshop clipColor).
vec3 dxClipColor(vec3 c) {
  float l = luma(c);
  float n = min(c.r, min(c.g, c.b));
  float x = max(c.r, max(c.g, c.b));
  if (n < 0.0) c = l + (c - l) * l / max(l - n, 1e-5);
  if (x > 1.0) c = l + (c - l) * (1.0 - l) / max(x - l, 1e-5);
  return c;
}

// b = this layer (backdrop), s = the texture (source). Same ladder as the lab.
vec3 dxBlend(float m, vec3 b, vec3 s) {
  if (m < 0.5)       return s;
  else if (m < 1.5)  return 1.0 - (1.0 - b) * (1.0 - s);
  else if (m < 2.5)  return max(b, s);
  else if (m < 3.5)  return min(b + s, 1.0);
  else if (m < 4.5)  return b * s;
  else if (m < 5.5)  return min(b, s);
  else if (m < 6.5)  return mix(2.0 * b * s, 1.0 - 2.0 * (1.0 - b) * (1.0 - s), step(vec3(0.5), b));
  else if (m < 7.5)  return (1.0 - 2.0 * s) * b * b + 2.0 * s * b;
  else if (m < 8.5)  return mix(2.0 * b * s, 1.0 - 2.0 * (1.0 - b) * (1.0 - s), step(vec3(0.5), s));
  else if (m < 9.5)  return abs(b - s);
  else if (m < 10.5) return b + s - 2.0 * b * s;
  else if (m < 11.5) return min(b / max(1.0 - s, 1e-3), 1.0);
  else if (m < 12.5) return 1.0 - min((1.0 - b) / max(s, 1e-3), 1.0);
  else if (m < 13.5) return dxClipColor(b + (luma(s) - luma(b)));
  else               return dxClipColor(s + (luma(b) - luma(s)));
}

vec4 fx(vec2 uv) {
  vec4 src = texture2D(uTexture, uv);
  vec4 tex = texture2D(uTexture1, uv);
  float blendMode = uParams[0];
  float region = uParams[1];
  float tones = uParams[2];
  float sil = uParams[3];
  float keyThr = uParams[4] / 100.0;
  float keySoft = max(uParams[5] / 100.0, 0.002);
  float subjDesat = uParams[6] / 100.0;
  float texContrast = uParams[7] / 100.0;
  float texBright = uParams[8] / 100.0;
  float texDesat = uParams[9] / 100.0;
  float fadeMode = uParams[10];
  float fadeAngle = uParams[11] * 0.017453292;
  float fadePos = uParams[12] / 100.0;
  float fadeWidth = max(uParams[13] / 100.0, 0.002);
  float duo = uParams[14] / 100.0;

  // ── silhouette: this layer's alpha, or a luma key cut from its picture ──
  vec3 s = clamp(unpremult(src), 0.0, 1.0);
  float sa = src.a;
  float m = sa;
  if (sil > 0.5) {
    float k = smoothstep(keyThr - keySoft, keyThr + keySoft, luma(s));
    m = (sil < 1.5 ? k : 1.0 - k) * sa;
  }
  s = mix(s, vec3(luma(s)), subjDesat);

  // ── texture: the referenced layer's plate, graded ──
  vec3 b = clamp(unpremult(tex), 0.0, 1.0);
  b = (b - 0.5) * texContrast + 0.5 + texBright;
  b = clamp(mix(b, vec3(luma(b)), texDesat), 0.0, 1.0);

  // ── fade edge across the layer's box (centred, height = 1) ──
  vec2 lp = fxLocal(uv);
  vec2 c = (lp - 0.5) * vec2(fxAspect(), 1.0);
  float fp = dot(c, vec2(cos(fadeAngle), -sin(fadeAngle)));
  float fade = fadeMode < 0.5 ? 1.0 : 1.0 - smoothstep(fadePos - fadeWidth * 0.5, fadePos + fadeWidth * 0.5, fp);

  // ── where the texture is allowed ──
  float gate = region < 0.5 ? m : (region < 1.5 ? 1.0 : 1.0 - m);
  float tone = tones < 0.5 ? 1.0 : (tones < 1.5 ? 1.0 - luma(s) : luma(s));
  tone = mix(1.0, tone, m);
  float w = tex.a * gate * tone * (fadeMode > 0.5 && fadeMode < 1.5 ? fade : 1.0);

  // ── composite: texture (w) with blend mode over this layer (m) ──
  vec3 blended = clamp(dxBlend(blendMode, s, b), 0.0, 1.0);
  vec3 rgb = (1.0 - m) * w * b + (1.0 - w) * m * s + w * m * blended;
  float a = w + m * (1.0 - w);
  if (fadeMode > 1.5) { rgb *= fade; a *= fade; }

  // ── duotone on the finished plate ──
  if (duo > 0.001) {
    vec3 col = rgb / max(a, 1e-4);
    vec3 shadow = uColors[0];
    vec3 high = uColors[1];
    col = mix(col, mix(shadow, high, luma(col)), duo);
    rgb = clamp(col, 0.0, 1.0) * a;
  }
  return vec4(rgb, clamp(a, 0.0, 1.0));
}
`;

export const DOUBLE_EXPOSURE_EFFECT = {
  id: DOUBLE_EXPOSURE_ID,
  name: 'Double Exposure',
  group: 'Color',
  animated: false,
  pro: true,
  // Whole-frame / Outside write beyond this layer's alpha on purpose.
  layerMatte: 'expand',
  usesLayerRef: 'sourceLayer',
  // The texture layer is part of THIS layer: it must not draw itself.
  consumesLayerRef: true,
  // LIVE only (user's call, 10.7.22): the texture is the layer AS DRAWN — on
  // another channel, on screen with this clip. No source-picture fallback: a
  // reference that is not on screen is a bypass, and the picker offers only
  // layers that can be live.
  layerRefMode: 'live',
  params: [
    { key: 'sourceLayer', type: 'layer', label: 'Texture Layer', default: '',
      title: 'Another layer in this project whose picture fills this layer\'s silhouette',
      // Rendered under the select. The rule is structural: a channel shows one
      // item at a time, so the texture has to live on ANOTHER channel and
      // overlap this clip in time — the picker only lists such layers.
      note: 'The texture must be a layer on another channel that overlaps this clip in time. It is used as drawn — position, scale, keyframes, effects — and while the effect is on it is hidden on its own and shows only inside this layer.' },
    { key: 'blend', slot: 0, label: 'Blend Mode', type: 'select', default: 1, primary: true,
      options: DOUBLE_EXPOSURE_BLENDS },
    { key: 'region', slot: 1, label: 'Texture Where', type: 'select', default: 0,
      options: [
        { value: 0, label: 'Inside the silhouette' },
        { value: 1, label: 'Whole frame' },
        { value: 2, label: 'Outside only' },
      ] },
    { key: 'tones', slot: 2, label: 'Weighted By', type: 'select', default: 0,
      options: [
        { value: 0, label: 'Nothing' },
        { value: 1, label: 'Layer shadows' },
        { value: 2, label: 'Layer highlights' },
      ] },
    { key: 'silhouette', slot: 3, label: 'Silhouette From', type: 'select', default: 0,
      options: [
        { value: 0, label: 'Layer alpha' },
        { value: 1, label: 'Luma · dark is background' },
        { value: 2, label: 'Luma · bright is background' },
      ] },
    // Only the luma keys read these; under "Layer alpha" the card hides them.
    { key: 'keyThreshold', slot: 4, label: 'Key Threshold', min: 0, max: 100, step: 0.5, default: 12, suffix: '%',
      showIf: { key: 'silhouette', oneOf: [1, 2] } },
    { key: 'keySoftness', slot: 5, label: 'Key Softness', min: 0, max: 50, step: 0.5, default: 10, suffix: '%',
      showIf: { key: 'silhouette', oneOf: [1, 2] } },
    { key: 'desaturate', slot: 6, label: 'Desaturate Layer', min: 0, max: 100, step: 1, default: 0, suffix: '%' },
    { key: 'texContrast', slot: 7, label: 'Texture Contrast', min: 0, max: 200, step: 1, default: 100, suffix: '%' },
    { key: 'texBrightness', slot: 8, label: 'Texture Brightness', min: -100, max: 100, step: 1, default: 0, suffix: '%' },
    { key: 'texDesaturate', slot: 9, label: 'Texture Desaturate', min: 0, max: 100, step: 1, default: 0, suffix: '%' },
    { key: 'fade', slot: 10, label: 'Fade Edge', type: 'select', default: 1,
      options: [
        { value: 0, label: 'Off' },
        { value: 1, label: 'Fades the texture' },
        { value: 2, label: 'Fades texture and layer' },
      ] },
    { key: 'fadeAngle', slot: 11, label: 'Fade Direction', min: -180, max: 180, step: 1, default: 90, suffix: '°',
      showIf: { key: 'fade', oneOf: [1, 2] } },
    { key: 'fadePosition', slot: 12, label: 'Fade Position', min: -200, max: 200, step: 1, default: 15, suffix: '%',
      showIf: { key: 'fade', oneOf: [1, 2] } },
    { key: 'fadeWidth', slot: 13, label: 'Fade Width', min: 0, max: 200, step: 1, default: 50, suffix: '%',
      showIf: { key: 'fade', oneOf: [1, 2] } },
    { key: 'duotone', slot: 14, label: 'Duotone', min: 0, max: 100, step: 1, default: 0, suffix: '%' },
    { key: 'duoShadow', type: 'color', colorSlot: 0, label: 'Duotone Shadows', default: '#1b2a4a' },
    { key: 'duoHighlight', type: 'color', colorSlot: 1, label: 'Duotone Highlights', default: '#f6e7c8' },
  ],
  colorPresets: [
    { name: 'Classic', colors: [], params: { blend: 1, region: 0, fade: 1, fadeAngle: 90, fadePosition: 12, fadeWidth: 50, desaturate: 35, texDesaturate: 30, duotone: 0 } },
    { name: 'Noir', colors: [], params: { blend: 2, region: 0, fade: 2, fadeAngle: 90, fadePosition: 20, fadeWidth: 55, desaturate: 100, texDesaturate: 60, texContrast: 110, texBrightness: -18, duotone: 0 } },
    { name: 'Window', colors: [], params: { blend: 4, region: 0, fade: 0, desaturate: 100, duotone: 0 } },
    { name: 'Duotone', colors: ['#1a2440', '#f2d9a6'], params: { blend: 1, region: 0, fade: 1, fadeAngle: 90, fadePosition: 14, fadeWidth: 50, desaturate: 100, texDesaturate: 100, duotone: 100 } },
    { name: 'Negative', colors: [], params: { blend: 9, region: 1, fade: 0, desaturate: 100, texContrast: 120, duotone: 0 } },
    { name: 'Dream', colors: [], params: { blend: 1, region: 1, fade: 0, texContrast: 130, texDesaturate: 50, duotone: 0 } },
  ],
  passes: [
    { key: 'main', target: 'out', main: true, inputs: { uTexture: 'source', uTexture1: 'ref' }, fragment: DX_MAIN_FX },
  ],
};
