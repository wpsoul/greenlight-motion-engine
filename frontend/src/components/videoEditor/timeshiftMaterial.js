/*
 * TimeShift's GPU materials, split out from timeshiftEffect.js for the same
 * reason Echo splits: the param leaf is imported by adjustmentEffects.js, which
 * the capability generator pulls into plain Node, so `three` and the material
 * factory have to stay on this side.
 *
 * TWO materials, and only two:
 *
 *   record  copies the current plate into ONE tile of the ring atlas, with a
 *           whole-atlas quad that discards every fragment outside that tile —
 *           see RECORD_FRAGMENT for why it is not a viewport.
 *   streak  the effect. One pass, T texture reads, no ping-pong.
 *
 * ── ALPHA ───────────────────────────────────────────────────────────────────
 * The chain's plates are PREMULTIPLIED. That is exactly right for this effect
 * and not a complication: premultiplied rgb IS light (colour x coverage), and a
 * streak integrates light, so accumulating it linearly is the physically correct
 * thing rather than a workaround. Two consequences are load-bearing:
 *
 *   - the RANGE qualifier reads UNPREMULTIPLIED colour, because "is this pixel
 *     bright" is a question about the colour, not about the coverage. Keying the
 *     premultiplied value would make everything semi-transparent read as dark and
 *     silently drop out of a highlight window.
 *   - the gate gap multiplies rgb ONLY. It is an unexposed strip: it removes
 *     light, not coverage. Scaling alpha too would punch a hole in the plate
 *     instead of darkening it.
 *
 * The output re-clamps rgb <= a, the same invariant Echo's accumulator enforces,
 * so no pass can leave an invalid premultiplied colour behind.
 */
import * as THREE from 'three';
import { materials as makeMaterial } from './materialFactory';
import { TS_MAX_SAMPLES } from './timeshiftEffect';

const VERTEX = /* glsl */ `
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

/*
 * Write the plate into one atlas tile.
 *
 * NO VIEWPORT AND NO SCISSOR, deliberately. The obvious implementation sets a
 * viewport on the tile rect, but viewport and scissor origins are bottom-left on
 * WebGL and top-left on WebGPU, so that version has to get a Y convention RIGHT
 * — and a wrong one here is the silent vertical flip that has shipped in this
 * codebase more times than any other bug.
 *
 * Instead the quad covers the WHOLE atlas, every fragment works out which tile
 * it is in, and the ones outside the target tile discard. The tile mapping is
 * then derived from `floor(atlasUv * grid)` in BOTH this pass and the streak
 * pass that reads it back, so whatever convention the backend applies to
 * gl_FragCoord is applied identically to the write and the read — and CANCELS.
 * Orientation stops being something to get right and becomes something that
 * cannot be got wrong.
 *
 * The cost is rasterising the whole atlas to keep one tile, but the discarded
 * fragments exit before any texture fetch, so it is a few tenths of a
 * millisecond. Do NOT clear the target: the other tiles are the ring.
 */
const RECORD_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D uPlate;
uniform vec2 uAtlasPx;
uniform vec2 uGrid;
uniform float uSlot;
void main() {
  vec2 atlasUv = gl_FragCoord.xy / uAtlasPx;
  vec2 cell = floor(atlasUv * uGrid);
  if (abs(cell.y * uGrid.x + cell.x - uSlot) > 0.5) discard;
  gl_FragColor = texture2D(uPlate, clamp(fract(atlasUv * uGrid), 0.0, 1.0));
}
`;

/*
 * One exposure of the TSB.
 *
 * The film is moving while the shutter is open, so the output pixel is the
 * integral of the picture SLIDING past the gate. Walking along the travel axis
 * is therefore also walking backwards through the open-shutter interval.
 *
 * The wrap is the whole trick: the along-axis coordinate is the position of the
 * film in the gate, so crossing +-0.5 means the gate is now looking at the
 * NEIGHBOURING FRAME. Spatial distance becomes distance in TIME.
 */
const STREAK_FRAGMENT = /* glsl */ `
precision highp float;

uniform sampler2D uAtlas;
uniform sampler2D uPlate;
uniform vec2  uResolution;
uniform vec2  uGrid;        // atlas tiles: cols, rows
uniform vec2  uTilePx;      // one tile, in texels
uniform float uHead;        // atlas slot holding the newest frame
uniform float uFilled;      // valid frames in the ring
uniform float uCap;

uniform vec2  uDir;         // film travel, unit, on the uv plane
uniform float uShift;       // travel while the shutter is open, in frame pitches
uniform float uShutter;     // shutter open time, in frames
uniform float uTaps;
uniform float uFall;
uniform float uWrap;
uniform float uGap;
uniform float uGain;
uniform float uHeadroom;

uniform float uRange, uRLo, uRHi, uRSoft, uRHue, uRHueW, uRSat, uRInvert;
uniform float uMix;
uniform float uSeed;

const int MAX_TAPS = ${TS_MAX_SAMPLES};

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float hash21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }

// Straight colour out of a premultiplied sample. Coverage must not read as
// darkness or every soft edge falls out of a highlight window.
vec3 straight(vec4 c) { return c.a > 1e-4 ? c.rgb / c.a : c.rgb; }

float rangeMask(vec4 pm) {
  if (uRange < 0.5) return 1.0;
  vec3 c = straight(pm);
  float sft = max(uRSoft, 0.002);
  float m;
  if (uRange < 1.5) {
    float l = luma(c);
    m = smoothstep(uRLo - sft, uRLo + sft, l) * (1.0 - smoothstep(uRHi - sft, uRHi + sft, l));
  } else {
    float mx = max(c.r, max(c.g, c.b));
    float mn = min(c.r, min(c.g, c.b));
    float d = mx - mn;
    float sat = mx <= 0.0 ? 0.0 : d / mx;
    float h = 0.0;
    if (d > 1e-5) {
      if (mx == c.r)      h = mod((c.g - c.b) / d, 6.0);
      else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
      else                h = (c.r - c.g) / d + 4.0;
      h *= 60.0;
      if (h < 0.0) h += 360.0;
    }
    float hd = abs(h - uRHue);
    hd = min(hd, 360.0 - hd);                       // hue is a circle
    m = (1.0 - smoothstep(uRHueW, uRHueW + sft * 180.0, hd))
      * smoothstep(uRSat - sft, uRSat + sft, sat);
  }
  return uRInvert > 0.5 ? 1.0 - m : m;
}

/*
 * Film integrates LIGHT, and the highlights that make this look are many stops
 * over clipping. Averaging 8-bit samples throws that away and turns every streak
 * to grey mush, so samples are expanded into headroom before they are summed and
 * compressed back afterwards — inverse-Reinhard, average, Reinhard.
 *
 * Valid only for c in [0,1], and uHeadroom < 1 keeps the denominator positive
 * there. GAIN IS APPLIED TO THE EXPANDED VALUE, never to c: a sample above
 * 1/uHeadroom sends the denominator negative and blows the whole frame white.
 * At uHeadroom 0 this is exactly a plain energy-conserving average, and
 * compress(expand(c)) is the identity at any setting.
 */
vec3 expand(vec3 c) { return c / max(1.0 - uHeadroom * clamp(c, 0.0, 1.0), 1e-3); }
vec3 compress(vec3 e) { return e / (1.0 + uHeadroom * e); }

// One ring slot, out of the tile grid. The col/row here is the exact inverse of
// the record pass's floor(atlasUv * grid), which is what makes the pair
// orientation-cancelling - see RECORD_FRAGMENT.
// (No backticks in this comment: it lives inside a JS template literal.)
//
// The half-texel inset matters: without it LINEAR filtering bleeds a tile into
// its neighbour, which reads as a faint ghost of an unrelated frame along every
// tile seam.
vec4 atlasAt(vec2 uv, float slot) {
  float s = mod(slot + uCap * 64.0, uCap);
  float col = mod(s, uGrid.x);
  float row = floor(s / uGrid.x);
  vec2 inset = 0.5 / uTilePx;
  vec2 c = clamp(uv, inset, vec2(1.0) - inset);
  return texture2D(uAtlas, (vec2(col, row) + c) / uGrid);
}

// Addressed in FRAMES BACK from now. The newest frame is served from the
// full-res PLATE rather than its atlas tile — same image, more resolution — so a
// reduced ring only ever softens the deeper taps, which are streaked anyway.
vec4 ringAt(vec2 uv, float back) {
  float maxb = max(0.0, uFilled - 1.0);
  back = clamp(back, 0.0, maxb);
  float f0 = floor(back);
  float fr = back - f0;
  vec4 a = f0 < 0.5 ? texture2D(uPlate, clamp(uv, 0.0, 1.0)) : atlasAt(uv, uHead - f0);
  if (fr <= 0.0) return a;
  float b1 = min(f0 + 1.0, maxb);
  vec4 b = b1 < 0.5 ? texture2D(uPlate, clamp(uv, 0.0, 1.0)) : atlasAt(uv, uHead - b1);
  return mix(a, b, fr);
}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec4 plate = texture2D(uPlate, uv);

  float c0 = dot(uv - 0.5, uDir);
  vec2  perp = (uv - 0.5) - c0 * uDir;

  // A long streak needs far more samples than the cap to stay smooth, so the fan
  // is dithered per pixel. That turns hard banding into grain, which is the one
  // kind of noise this look is allowed to have.
  float dith = (hash21(gl_FragCoord.xy * 0.7 + uSeed) - 0.5) / max(uTaps - 1.0, 1.0);

  vec3  acc = vec3(0.0);
  float accA = 0.0;
  float wsum = 0.0;
  int taps = int(uTaps);

  for (int i = 0; i < MAX_TAPS; i++) {
    if (i >= taps) break;
    float u = uTaps <= 1.0 ? 0.0 : clamp(float(i) / (uTaps - 1.0) + dith, 0.0, 1.0);

    float cc = c0 + u * uShift;
    float k = uWrap > 0.5 ? floor(cc + 0.5) : 0.0;   // frame boundaries crossed
    float cw = cc - k;
    vec2 p = 0.5 + perp + cw * uDir;
    if (uWrap < 0.5) p = clamp(p, 0.0, 1.0);

    // Only the past exists in a ring, so a boundary crossed in either direction
    // reads as one frame further back rather than one frame forward.
    vec4 s = ringAt(p, u * uShutter + abs(k));

    // The unexposed strip between frames rides along in the smear, which is why
    // it reads as a soft dark streak and never as a hard bar. rgb only: it takes
    // light away, not coverage.
    if (uGap > 0.0) s.rgb *= 1.0 - uGap * smoothstep(0.5 - 0.055, 0.5, abs(cw));

    // The shutter is not a box: it opens and closes, so the ends of the streak
    // carry less light than the middle.
    float w = mix(1.0, sin(3.14159265 * u) + 0.08, uFall);
    float sel = rangeMask(s);
    acc  += expand(s.rgb) * (w * sel);
    accA += s.a * (w * sel);
    wsum += w;
  }

  float inv = 1.0 / max(wsum, 1e-4);
  acc *= inv;
  accA *= inv;

  // Whatever the range did NOT select never entered the streak, so it is added
  // back sharp, from this instant at full resolution. Summing in headroom and
  // compressing once keeps the two halves from clipping against each other —
  // and with the range off it is zero, so the chain is unchanged.
  vec3  keep = vec3(0.0);
  float keepA = 0.0;
  if (uRange > 0.5) {
    float ks = 1.0 - rangeMask(plate);
    keep = expand(plate.rgb) * ks;
    keepA = plate.a * ks;
  }

  vec4 outc;
  outc.rgb = compress((acc + keep) * uGain);
  outc.a = clamp(accA + keepA, 0.0, 1.0);
  outc.rgb = min(outc.rgb, vec3(outc.a));

  // mix 0 is an exact bypass however many samples ran.
  gl_FragColor = mix(plate, outc, uMix);
}
`;

export function createTimeShiftRecordMaterial() {
  return makeMaterial.timeshiftRecord() ?? new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: RECORD_FRAGMENT,
    transparent: false,
    blending: THREE.NoBlending,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      uPlate: { value: null },
      uAtlasPx: { value: new THREE.Vector2(2880, 1620) },
      uGrid: { value: new THREE.Vector2(3, 3) },
      uSlot: { value: 0 },
    },
  });
}

export function createTimeShiftStreakMaterial() {
  return makeMaterial.timeshiftStreak() ?? new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: STREAK_FRAGMENT,
    transparent: false,
    blending: THREE.NoBlending,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      uAtlas: { value: null },
      uPlate: { value: null },
      uResolution: { value: new THREE.Vector2(1920, 1080) },
      uGrid: { value: new THREE.Vector2(3, 3) },
      uTilePx: { value: new THREE.Vector2(960, 540) },
      uHead: { value: 0 },
      uFilled: { value: 0 },
      uCap: { value: 8 },
      uDir: { value: new THREE.Vector2(0, 1) },
      uShift: { value: 0.3 },
      uShutter: { value: 0.5 },
      uTaps: { value: 24 },
      uFall: { value: 0.5 },
      uWrap: { value: 1 },
      uGap: { value: 0 },
      uGain: { value: 1 },
      uHeadroom: { value: 0.97 },
      uRange: { value: 0 },
      uRLo: { value: 0.62 },
      uRHi: { value: 1 },
      uRSoft: { value: 0.12 },
      uRHue: { value: 40 },
      uRHueW: { value: 40 },
      uRSat: { value: 0.25 },
      uRInvert: { value: 0 },
      uMix: { value: 1 },
      uSeed: { value: 0 },
    },
  });
}
