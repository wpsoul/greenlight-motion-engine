// Shape Rulers geometry, shared by the Shape Rulers overlay effect
// (adjustmentEffects.js) and the Zoom Ruler transition (builtinTransitionPackages.js)
// so a ruler looks the same wherever it is drawn. Look-dev: html/shape-rulers-lab.html
// and html/zoom-ruler-transition-lab.html. The TSL twins live in shapeRulersNodes.js.
//
// Pure functions of their arguments, in pixels. Mark shapes: 0 square, 1 circle,
// 2 diamond, 3 square outline, 4 circle outline, 5 cross, 6 corner bracket
// (7 = none is the caller's to skip).
export const SHAPE_RULERS_GLSL = /* glsl */ `
float srSdBox(vec2 p, vec2 b, float r) {
  r = min(r, min(b.x, b.y));
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
// One guide: across = distance to its axis, along = position on it from the box
// centre, halfLen = the box half-extent along it. 1 px box-filter AA on every edge.
float srGuide(float across, float along, float halfLen, float lw, float ext, float dash) {
  float w = clamp(lw * 0.5 + 0.5 - across, 0.0, 1.0);
  float a = abs(along);
  float seg = clamp(halfLen + ext - a + 0.5, 0.0, 1.0);
  if (dash > 0.5) {
    // Pattern anchored on the corner, so every corner reads the same.
    float ph = mod(abs(a - halfLen), 2.0 * dash);
    seg *= clamp(dash - ph + 0.5, 0.0, 1.0);
  }
  return w * seg;
}
// Signed distance to one mark. q = offset from the mark centre with +x/+y pointing
// OUT of the box; edge 0 = corner, 1 = middle of a vertical edge, 2 = of a horizontal one.
float srMark(vec2 q, vec2 hs, float edge, float shape, float r, float t) {
  float m = min(hs.x, hs.y);
  if (shape < 0.5) return srSdBox(q, hs, r);
  if (shape < 1.5) return (length(q / hs) - 1.0) * m;
  if (shape < 2.5) return (abs(q.x) / hs.x + abs(q.y) / hs.y - 1.0) * hs.x * hs.y / length(hs);
  if (shape < 3.5) return abs(srSdBox(q, hs - 0.5 * t, max(r - 0.5 * t, 0.0))) - 0.5 * t;
  if (shape < 4.5) return abs((length(q / hs) - 1.0) * m + 0.5 * t) - 0.5 * t;
  if (shape < 5.5) return min(srSdBox(q, vec2(hs.x, 0.5 * t), 0.0), srSdBox(q, vec2(0.5 * t, hs.y), 0.0));
  // Bracket: two arms running back along the box edges from the corner; on an
  // edge midpoint it is a short bar lying on that edge.
  if (edge > 1.5) return srSdBox(q, vec2(hs.x, 0.5 * t), 0.0);
  if (edge > 0.5) return srSdBox(q, vec2(0.5 * t, hs.y), 0.0);
  return min(srSdBox(q - vec2(0.25 * t - hs.x, 0.0), vec2(hs.x + 0.25 * t, 0.5 * t), 0.0),
             srSdBox(q - vec2(0.0, 0.25 * t - hs.y), vec2(0.5 * t, hs.y + 0.25 * t), 0.0));
}
// Line and mark coverage for a point q (px from the box centre, box axes) around a
// ruler box of half size H. Sizes arrive already in target pixels.
vec2 srCoverage(vec2 q, vec2 H, float lw, float ext, float dash, float shape, vec2 hs, float r, float t, float mid) {
  float lines = max(srGuide(abs(abs(q.x) - H.x), q.y, H.y, lw, ext, dash),
                    srGuide(abs(abs(q.y) - H.y), q.x, H.x, lw, ext, dash));
  float mark = 0.0;
  if (shape < 6.5) {
    float md = srMark(abs(q) - H, hs, 0.0, shape, r, t);
    if (mid > 0.5) {
      md = min(md, srMark(vec2(abs(q.x) - H.x, q.y), hs, 1.0, shape, r, t));
      md = min(md, srMark(vec2(q.x, abs(q.y) - H.y), hs, 2.0, shape, r, t));
    }
    mark = clamp(0.5 - md, 0.0, 1.0);
  }
  return vec2(lines, mark);
}
`;
