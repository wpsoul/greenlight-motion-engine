/*
 * Grid — analytic grid lines as an Overlay Effect (one pass, no textures).
 *
 * Look-dev and gates: html/overlay-effects-lab.html +
 * tests/layer-effect-labs/verify_overlay_effects.js.
 *
 * Lines are measured in the layer's own box (Halftone's rule: px at 1080p of
 * the box), so on a layer the grid is printed on the artwork and moves with
 * it; an adjustment layer's box is the frame. A line passes through the box
 * centre + Offset, so Offset pans the grid and Rotation turns it (clockwise +)
 * about that point.
 *
 * Coverage is the exact overlap of the line with the pixel's footprint across
 * the line's normal (fwidth of the grid coordinate), so sub-pixel widths fade
 * instead of flickering and a rotated or scaled layer stays anti-aliased.
 * Frame scope + an axis-aligned grid snaps the centre so odd widths land on
 * pixel centres: a 1 px hairline is ONE crisp pixel, not two half-strength
 * ones. Offsets stay continuous, so a drift animates smoothly.
 *
 * On a layer the lines take the layer's own alpha (premultiplied by it), so
 * the effect never adds or removes coverage — no matte clip, no squared alpha
 * on a half-transparent layer. Over an adjustment layer the lines are opaque,
 * like any generator. Mix is the opacity.
 *
 * Box maths goes through fxLocal, orientation-normalised on both backends; the
 * TSL twin (BODIES.gridLines in adjustmentEffectNodes.js) ports it verbatim.
 */
export const GRID_LINES_EFFECT = {
  id: 'gridLines',
  name: 'Grid',
  group: 'Graphic',
  animated: false,
  layerMatte: 'expand',
  params: [
    { key: 'lines', slot: 3, label: 'Lines', type: 'select', default: 0, primary: true,
      options: [
        { value: 0, label: 'Columns and Rows' },
        { value: 1, label: 'Columns Only' },
        { value: 2, label: 'Rows Only' },
      ] },
    { key: 'cellSize', slot: 0, label: 'Cell Size', min: 4, max: 600, step: 1, default: 120, suffix: 'px' },
    { key: 'lineWidth', slot: 1, label: 'Line Width', min: 0, max: 40, step: 0.25, default: 1.5, suffix: 'px' },
    { key: 'rotation', slot: 2, label: 'Rotation', min: -180, max: 180, step: 0.5, default: 0, suffix: '°' },
    { key: 'offsetX', slot: 4, label: 'Offset X', min: -1000, max: 1000, step: 1, default: 0, suffix: 'px' },
    { key: 'offsetY', slot: 5, label: 'Offset Y', min: -1000, max: 1000, step: 1, default: 0, suffix: 'px' },
    { key: 'color', type: 'color', label: 'Color', default: '#ffffff' },
  ],
  colorPresets: [
    { name: 'Hairline', params: { color: '#ffffff', cellSize: 120, lineWidth: 1, rotation: 0, lines: 0 } },
    { name: 'Blueprint', params: { color: '#6ec3ff', cellSize: 60, lineWidth: 1.25, rotation: 0, lines: 0 } },
    { name: 'Columns', params: { color: '#ffffff', cellSize: 240, lineWidth: 2, rotation: 0, lines: 1 } },
    { name: 'Rows', params: { color: '#ffffff', cellSize: 48, lineWidth: 1, rotation: 0, lines: 2 } },
    { name: 'Diagonal', params: { color: '#7cf0b4', cellSize: 90, lineWidth: 1.5, rotation: 45, lines: 0 } },
    { name: 'Bold', params: { color: '#0b0b0b', cellSize: 180, lineWidth: 8, rotation: 0, lines: 0 } },
  ],
  bypassIf: (p) => !(Number(p?.lineWidth) > 0),
  fragment: /* glsl */ `
float glCover(float d, float w, float f) {
  float h = 0.5 * w;
  float lo = max(-h, d - 0.5 * f);
  float hi = min(h, d + 0.5 * f);
  return clamp((hi - lo) / f, 0.0, 1.0);
}
vec4 fx(vec2 uv) {
  vec4 base = texture2D(uTexture, uv);
  vec2 S = fxRes();
  float ref = S.y / 1080.0;
  float cell = max(uParams[0], 1.0) * ref;
  float width = max(uParams[1], 0.0) * ref;
  float rot = radians(uParams[2]);
  float lines = uParams[3];
  vec2 lp = fxLocal(uv);
  vec2 pd = vec2(lp.x, 1.0 - lp.y) * S;              // box px, y down
  vec2 c = 0.5 * S;
  float rm = mod(uParams[2], 90.0);
  if (uFxLayer < 0.5 && (rm < 1e-3 || rm > 90.0 - 1e-3)) {
    c = mod(floor(width + 0.5), 2.0) > 0.5 ? floor(c) + 0.5 : floor(c + 0.5);
  }
  c += vec2(uParams[4], uParams[5]) * ref;
  vec2 q0 = pd - c;
  float cs = cos(rot);
  float sn = sin(rot);
  vec2 q = vec2(cs * q0.x + sn * q0.y, -sn * q0.x + cs * q0.y);
  vec2 fw = max(fwidth(q), vec2(1e-4));
  vec2 d = abs(fract(q / cell + 0.5) - 0.5) * cell;
  float cx = lines > 1.5 ? 0.0 : glCover(d.x, width, fw.x);
  float cy = (lines > 0.5 && lines < 1.5) ? 0.0 : glCover(d.y, width, fw.y);
  float cov = 1.0 - (1.0 - cx) * (1.0 - cy);
  float a = uFxLayer > 0.5 ? base.a : 1.0;
  return base * (1.0 - cov) + vec4(uColor * a, a) * cov;
}
`,
};
