import { createTransitionPackageMaterialForBackend } from './materialFactory.js';
import { EASING_BEZIER, SAMPLED_EASING_VALUES } from './easingCurves.js';
import { namedEase } from './appEases.js';
import { TransitionEasing } from './types.js';
import { CAMERA_WHIP_NODE_SAMPLES } from './cameraWhipSamples.js';
import { SHAPE_RULERS_GLSL } from './shapeRulersGlsl.js';

// Built-in executable transition packages. These ship with the app but run on
// the same package runtime as user-imported .gltransition files: Player captures
// both clip plates, hides the clip planes, and hands the textures + progress to
// createInstance()'s renderer. Everything here derives from progress only —
// no wall clock, no Math.random — matching the package determinism contract.
//
// Look-dev sources (the visual truth for these effects):
//   html/carousel-transition-lab.html        → 3D Carousel
//   html/carousel-skew-lab.html              → 3D Carousel skew + layer fit
//   html/advanced-transition-lab-2.html      → Louver Flip
//   html/circular-wipe-transition.html       → Circular Wipe
//   html/pixel-blocks-transition.html        → Pixel Blocks
//   html/camera-whip-transition.html         → Camera Whip
//   html/zoom-ruler-transition-lab.html      → Zoom Ruler
//   html/gradient-glow-stack-transition.html → Gradient Glow Stack
//   (no lab) SaaS Gradent Transitions.aep     → Gradient Map, decoded + rendered

// The carousel spins a rigid two-panel rig about an axis through the pivot.
// Panel A rests frontal at theta = 0 and panel B at theta = spacing, so BOTH
// endpoints are exactly frontal and plate-filling no matter which axis the rig
// turns about — that is what lets "Skew" tilt the axis without breaking the
// transition's start and end frames.
//
// The panel is a RECT, not necessarily the frame: uRectC/uRectH place the
// virtual camera square-on to the layer's own box and the plate is sampled from
// the matching sub-rect of the full-frame capture. rect = whole frame reproduces
// the original full-frame look exactly.
const CAROUSEL_FRAGMENT = /* glsl */ `
uniform sampler2D uPrevious;
uniform sampler2D uCurrent;
uniform float uRatio;      // composition width / height
uniform vec2  uRectC;      // panel rect centre, screen units (x in frame-height units)
uniform vec2  uRectH;      // panel rect half extents, same units
uniform float uTanHF;      // tan(fov / 2)
uniform float uOrtho;      // 1 = fov 0, a true orthographic camera (parallel rays)
uniform float uSpacing;    // slot angle between the two panels, radians
uniform float uRadiusMul;  // carousel radius in half-panel-widths
uniform float uShade;      // side-face darkening 0..1
uniform float uSign;       // +1 / -1 rotation direction
uniform vec2  uAxisSC;     // (sin, cos) of the spin axis tilt: axis = vec3(s, c, 0)
uniform float uShear;      // whip shear (parallelogram lean), 0 at both ends
uniform float uTheta0;     // rotation at shutter open
uniform float uTheta1;     // rotation at shutter close
uniform float uBgLift;
uniform float uBackdrop;   // 1 = opaque carousel backdrop, 0 = see through
uniform float uUseAlpha;   // 1 = honour the plate's own alpha (layer fit)
varying vec2 vUv;

const int SAMPLES = 16;

// Interleaved gradient noise: per-pixel deterministic jitter. Each pixel opens
// its shutter at a different phase so the 16 rotation samples integrate into a
// continuous smear instead of visible ghost copies.
float ign(vec2 p){ return fract(52.9829189 * fract(0.06711056 * p.x + 0.00583715 * p.y)); }

// Rodrigues rotation of v about unit axis a by (cos, sin) = (c, s).
vec3 rot3(vec3 v, vec3 a, float c, float s){
  return v * c + cross(a, v) * s + a * dot(a, v) * (1.0 - c);
}

// Intersect the view ray with one carousel panel at rig angle phi. W/H are the
// panel's half extents, k the whip shear slope. The ray carries an origin so the
// same solve covers the perspective camera (ro = 0) and the orthographic one.
// Returns vec4(panelU, panelV, dist, edgeAlpha); alpha 0 = miss.
vec4 panelHit(vec3 ro, vec3 rd, float phi, vec3 axis, vec2 ax, float W, float H, float D, float R, float k){
  float c = cos(phi), s = sin(phi);
  vec3 n = rot3(vec3(0.0, 0.0, 1.0), axis, c, s);
  if (dot(n, -rd) <= 0.0) return vec4(0.0);
  float denom = dot(rd, n);
  if (abs(denom) < 1e-5) return vec4(0.0);
  vec3 C = vec3(0.0, 0.0, -(D + R)) + R * n;
  float t = dot(C - ro, n) / denom;
  if (t < 1e-4) return vec4(0.0);
  vec3 d = ro + rd * t - C;
  float px = dot(d, rot3(vec3(1.0, 0.0, 0.0), axis, c, s));
  float py = dot(d, rot3(vec3(0.0, 1.0, 0.0), axis, c, s));
  // Un-shear in the (sweep, along-axis) frame: sweep dir = (ax.y, -ax.x).
  float sw = px * ax.y - py * ax.x;
  float al = px * ax.x + py * ax.y;
  sw -= k * al;
  px = sw * ax.y + al * ax.x;
  py = -sw * ax.x + al * ax.y;
  float u = px / W * 0.5 + 0.5;
  float v = py / H * 0.5 + 0.5;
  float aa = 0.004;
  float alpha = smoothstep(0.0, aa, u) * smoothstep(1.0, 1.0 - aa, u)
              * smoothstep(0.0, aa, v) * smoothstep(1.0, 1.0 - aa, v);
  if (alpha <= 0.0) return vec4(0.0);
  return vec4(u, v, t, alpha);
}

vec3 shadePanel(vec3 col, float phi, vec2 puv, vec2 ax, float W, float H, float effW){
  float facing = clamp(cos(phi), 0.0, 1.0);   // n . z == cos(phi) at any tilt
  col *= mix(1.0 - uShade, 1.0, facing);
  // Edge falloff runs across the SWEEP direction, which the tilt rotates too.
  float px = (puv.x - 0.5) * 2.0 * W, py = (puv.y - 0.5) * 2.0 * H;
  float sweep = (px * ax.y - py * ax.x) / (2.0 * effW);
  col *= 1.0 - 0.18 * uShade * smoothstep(0.35, 0.5, abs(sweep));
  return col;
}

void main(){
  vec2 ndc = vUv * 2.0 - 1.0;
  vec2 scr = vec2(ndc.x * uRatio, ndc.y);     // y spans [-1,1] over the frame height
  vec2 local = (scr - uRectC) / uRectH.y;
  float H = 1.0, W = uRectH.x / uRectH.y;
  // Camera distance so a front panel fills the rect. At fov 0 there is no such
  // distance — the camera is orthographic, so the rig sits at the origin and the
  // rays run parallel from a plane well in front of it.
  float D = mix(1.0 / max(uTanHF, 1e-6), 0.0, uOrtho);
  vec3 axis = vec3(uAxisSC.x, uAxisSC.y, 0.0);
  // Half extent perpendicular to the tilted axis — keeps "radius in
  // half-panel-widths" meaningful as the tilt turns W into H.
  float effW = W * abs(uAxisSC.y) + H * abs(uAxisSC.x);
  float R = uRadiusMul * effW;
  // Panel uv -> the matching sub-rect of the captured full-frame plate.
  vec2 uv0 = vec2(((uRectC.x - uRectH.x) / uRatio) * 0.5 + 0.5, (uRectC.y - uRectH.y) * 0.5 + 0.5);
  vec2 uvS = vec2(uRectH.x / uRatio, uRectH.y);

  vec3 bgCol = (vec3(0.03, 0.035, 0.05) + uBgLift) * (1.0 - 0.35 * length(ndc * vec2(0.7, 1.0)));
  vec4 bg = vec4(bgCol, 1.0) * uBackdrop;     // premultiplied; 0 = see through

  vec4 acc = vec4(0.0);
  float jitter = ign(gl_FragCoord.xy);
  for (int i = 0; i < SAMPLES; i++){
    float fs = (float(i) + jitter) / float(SAMPLES);
    float theta = mix(uTheta0, uTheta1, fs);
    float phiA = uSign * theta;
    float phiB = uSign * (theta - uSpacing);
    // Whip shear rides the rig, not the panel: the same lean on both panels,
    // zero at both ends of the turn, peak in the middle.
    float k = uShear * sin(3.14159265 * clamp(theta / max(uSpacing, 1e-4), 0.0, 1.0));

    // Perspective: every ray leaves the eye. Orthographic: each pixel gets its own
    // parallel ray, started far enough in front to clear the deepest panel corner.
    vec3 ro = uOrtho * vec3(local, 100.0);
    vec3 rd = mix(normalize(vec3(local.x * uTanHF, local.y * uTanHF, -1.0)), vec3(0.0, 0.0, -1.0), uOrtho);

    vec4 hA = panelHit(ro, rd, phiA, axis, uAxisSC, W, H, D, R, k);
    vec4 hB = panelHit(ro, rd, phiB, axis, uAxisSC, W, H, D, R, k);

    vec4 col = bg;
    for (int pass = 0; pass < 2; pass++){   // paint far panel, then near over it
      bool nearPass = (pass == 1);
      bool aNear = (hA.w > 0.0) && (hB.w <= 0.0 || hA.z <= hB.z);
      vec4 hh = (nearPass == aNear) ? hA : hB;
      float phi = (nearPass == aNear) ? phiA : phiB;
      bool isA = (nearPass == aNear);
      if (hh.w <= 0.0) continue;
      vec2 tuv = uv0 + clamp(hh.xy, 0.002, 0.998) * uvS;
      // Plates are PREMULTIPLIED (captured onto a cleared alpha-0 target), so
      // shading scales rgb and the plate's own alpha rides along. Frame fit
      // forces alpha 1, which is exactly the old opaque compositing.
      vec4 src = isA ? texture2D(uPrevious, tuv) : texture2D(uCurrent, tuv);
      src.rgb = shadePanel(src.rgb, phi, hh.xy, uAxisSC, W, H, effW);
      src.a = mix(1.0, src.a, uUseAlpha);
      src *= hh.w;
      col = src + col * (1.0 - src.a);
    }
    acc += col;
  }
  gl_FragColor = acc / float(SAMPLES);
}
`;

const LOUVER_FRAGMENT = /* glsl */ `
uniform sampler2D uPrevious;
uniform sampler2D uCurrent;
uniform float uProgress;
uniform float uSlats;
uniform float uStagger;    // per-slat delay as a fraction of the run
uniform float uShadeAmt;   // 0..1
uniform float uOrient;     // 0 = horizontal slats, 1 = vertical slats
varying vec2 vUv;

float ez(float t){ t = clamp(t, 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }

void main(){
  vec2 q = mix(vUv, vUv.yx, uOrient);
  float N = max(1.0, uSlats);
  float i = floor(q.y * N);
  float local = fract(q.y * N);
  float s = clamp(uProgress * (1.0 + (N - 1.0) * uStagger) - i * uStagger, 0.0, 1.0);
  float th = ez(s) * 3.14159265;
  float co = cos(th);
  float ac = max(abs(co), 0.02);
  float ly = (local - 0.5) / ac + 0.5;
  // Past an edge-on slat is whatever lies under the channel (transparent), and a
  // slat keeps its plate's premultiplied alpha — see makeTwoTextureInstance.
  if (ly < 0.0 || ly > 1.0){ gl_FragColor = vec4(0.0); return; }
  float gy = (i + ly) / N;
  vec2 suv = mix(vec2(q.x, gy), vec2(gy, q.x), uOrient);
  float shade = mix(1.0, 0.4 + 0.6 * ac, uShadeAmt);
  vec4 src = co > 0.0 ? texture2D(uPrevious, suv) : texture2D(uCurrent, suv);
  gl_FragColor = vec4(src.rgb * shade, src.a);
}
`;

// A feathered mask front has to travel `span + 2·feather`, starting one feather
// short: the soft edge is centred ON the front, so a front that merely runs 0 →
// span leaves the far corner part-revealed when the wipe ends (17% feather still
// showed 40% of the outgoing clip at t=1) and the wipe point half-revealed at
// t=0. Both ends then read as a hard cut. The beam rides the same signed
// distance, so it inherits the corrected travel for free.
const CIRCLE_WIPE_FRAGMENT = /* glsl */ `
uniform sampler2D uPrevious;
uniform sampler2D uCurrent;
uniform float uProgress;
uniform float uRatio;      // composition width / height
uniform vec2  uCenter;     // wipe point, UV (y up)
uniform float uMaxR;       // point → farthest corner, aspect-corrected
uniform float uFeather;    // fraction of uMaxR
uniform float uInvert;     // 1 = the circle closes onto the point
uniform float uBeam;       // master switch
uniform float uBeamMode;   // 0 = gradient runs along the ring, 1 = across the band
uniform float uBeamW;
uniform float uBeamI;
uniform float uBloomW;
uniform float uBloomI;
uniform float uFlow;       // gradient phase, in cycles
uniform float uBeamFade;   // fade in/out window, fraction of the wipe
uniform vec3  uC0;
uniform vec3  uC1;
uniform vec3  uC2;
uniform vec3  uC3;
uniform float uParZoom;
uniform float uParDrift;
uniform float uParPush;
varying vec2 vUv;

vec3 grad4(float t){
  float s = fract(t) * 4.0;
  if (s < 1.0) return mix(uC0, uC1, smoothstep(0.0, 1.0, s));
  if (s < 2.0) return mix(uC1, uC2, smoothstep(0.0, 1.0, s - 1.0));
  if (s < 3.0) return mix(uC2, uC3, smoothstep(0.0, 1.0, s - 2.0));
  return mix(uC3, uC0, smoothstep(0.0, 1.0, s - 3.0));
}

vec2 zoomAt(vec2 uv, vec2 c, float z){ return c + (uv - c) / max(z, 0.02); }

void main(){
  vec2 asp = vec2(uRatio, 1.0);
  vec2 p = (vUv - uCenter) * asp;
  float r = length(p);

  float prog = mix(uProgress, 1.0 - uProgress, uInvert);
  float fe = max(uFeather * uMaxR, 0.0015);
  float R = prog * (uMaxR + 2.0 * fe) - fe;
  float d = r - R;
  // Every smoothstep here keeps edge0 < edge1: reversed edges are undefined in the
  // GLSL spec even though the desktop drivers happen to ramp them backwards.
  float inside = 1.0 - smoothstep(-fe, fe, d);
  float mask = mix(inside, 1.0 - inside, uInvert);

  // The incoming clip settles out of a zoom and a drift anchored on the wipe
  // point; the outgoing one pushes past the camera. Both ride eased progress, so
  // the move lands exactly when the wipe does.
  float settle = uProgress;
  vec2 uvB = zoomAt(vUv, uCenter, mix(1.0 + uParZoom, 1.0, settle));
  uvB += (normalize(p + vec2(1e-5)) / asp) * uParDrift * (1.0 - settle) * 0.25;
  vec2 uvA = zoomAt(vUv, uCenter, 1.0 + uParPush * settle);

  // Plates are premultiplied, so mixing the whole vec4 IS the correct blend.
  vec4 col = mix(
    texture2D(uPrevious, clamp(uvA, 0.0, 1.0)),
    texture2D(uCurrent, clamp(uvB, 0.0, 1.0)),
    mask
  );

  if (uBeam > 0.5) {
    float bw = max(uBeamW * uMaxR, 0.002);
    float core = exp(-(d * d) / (bw * bw));
    float halo = exp(-abs(d) / max(uBloomW * uMaxR, 0.004));
    float ang = atan(p.y, p.x) * 0.15915494 + 0.5;
    vec3 gcol = grad4(mix(ang + uFlow, (d / bw) * 0.25 + uFlow, uBeamMode));
    // The beam exists only while its edge is on screen, and a wide bloom needs
    // the long tail — cut it short and the glow vanishes in a single frame.
    float fade = max(uBeamFade, 0.001);
    float alive = smoothstep(0.0, fade, prog) * (1.0 - smoothstep(1.0 - fade, 1.0, prog));
    // Darkening under the core keeps the gradient readable on bright footage;
    // pure addition blew out to white.
    col.rgb *= 1.0 - 0.45 * core * alive * min(uBeamI, 1.0);
    // Added to premultiplied colour and NOT to alpha, the beam behaves as light:
    // it glows over whatever sits behind instead of punching a hole in the frame.
    col.rgb += gcol * (core * uBeamI + halo * halo * uBloomI) * alive;
  }

  gl_FragColor = col;
}
`;

const clamp01 = (value) => Math.max(0, Math.min(1, value));
const finite = (value, fallback) => (Number.isFinite(value) ? value : fallback);

// Option colours are plain '#rrggbb' strings. They are parsed by hand rather than
// through THREE.Color so colour management cannot silently convert them to linear
// — the beam is authored in the same sRGB numbers the look-dev lab showed.
function setHexVec(vec, hex, fallback) {
  const raw = typeof hex === 'string' ? hex.trim().replace(/^#/, '') : '';
  const src = /^[0-9a-fA-F]{6}$/.test(raw) ? raw : fallback;
  vec.set(
    parseInt(src.slice(0, 2), 16) / 255,
    parseInt(src.slice(2, 4), 16) / 255,
    parseInt(src.slice(4, 6), 16) / 255,
  );
}

// The rect the carousel turns, in screen units (y spans [-1,1] over the frame
// height, x in those same units). "frame" is the whole composition; "layer" is
// the union of the two clips' screen boxes as the runtime measured them through
// the neutral capture camera, clamped to the frame because that is all the
// captured plate holds. A full-frame clip reports the whole frame, so the two
// modes agree on ordinary video and diverge only for a smaller layer.
//
// A layer entrance/exit has one clip, so the union is that clip's box alone —
// the empty lane reports bounds `null` and drops out of the filter below.
function layerFitRect(plateFit, frame, ratio, boundsKey = 'bounds') {
  const full = { cx: 0, cy: 0, hx: ratio, hy: 1, layerFit: false };
  if (plateFit !== 'layer') return full;
  const boxes = [frame.previous?.[boundsKey], frame.current?.[boundsKey]].filter(Boolean);
  if (!boxes.length) return full;   // unmeasurable box — the full frame is the honest fallback
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const box of boxes) {
    minX = Math.min(minX, Math.max(-1, box.minX));
    maxX = Math.max(maxX, Math.min(1, box.maxX));
    minY = Math.min(minY, Math.max(-1, box.minY));
    maxY = Math.max(maxY, Math.min(1, box.maxY));
  }
  if (!(maxX > minX) || !(maxY > minY)) return full;   // fully off-frame
  return {
    cx: ((minX + maxX) / 2) * ratio,
    cy: (minY + maxY) / 2,
    hx: Math.max(1e-3, ((maxX - minX) / 2) * ratio),
    hy: Math.max(1e-3, (maxY - minY) / 2),
    layerFit: true,
  };
}

// The carousel applies its own swing easing to rawProgress: motion blur needs
// the easing derivative (shutter window in angle space), which the pre-eased
// editor progress cannot provide. The editor easing selector therefore does not
// affect this transition; the "Swing ease" option replaces it.
const SWING_EASES = {
  smooth: (t) => t * t * (3 - 2 * t),
  cubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2),
  back: (t) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * ((t - 1) ** 3) + c1 * ((t - 1) ** 2); },
  linear: (t) => t,
};

/*
 * `pkgId` names the ported TSL twin; `fragmentShader` is the GLSL the WebGL path
 * still uses. These are the app's OWN built-ins, not SDK packages — the SDK is
 * TSL-only, and this pair exists purely so the built-ins keep working on both
 * backends until §5 deletes the WebGL renderer. A package author never sees it.
 */
function makeTwoTextureInstance({ THREE, sdk, root, width, height }, pkgId, fragmentShader, uniforms) {
  const nodeMat = createTransitionPackageMaterialForBackend(pkgId);
  let material;
  if (nodeMat) {
    // The twin owns its own uniform nodes, so seed them from the values this
    // call supplies — the same shape every other ported family uses.
    for (const [k, v] of Object.entries(uniforms)) {
      const slot = nodeMat.uniforms?.[k];
      if (!slot || v?.value === undefined || v.value === null) continue;
      if (slot.value && typeof slot.value === 'object' && typeof slot.value.copy === 'function'
          && v.value.copy) slot.value.copy(v.value);
      else slot.value = v.value;
    }
    material = nodeMat;
  } else {
    material = sdk.createGlslMaterialForWebgl({ fragmentShader, uniforms });
  }
  // Every built-in pass outputs premultiplied colour with REAL alpha — the plates
  // are premultiplied captures — so it composites like any other layer: the
  // premultiplied OVER, src + dst·(1 − a), sorted with its channel's stack. Drawn
  // opaque, as every cross used to be, a pass wrote premultiplied black over
  // everything under its channel wherever neither clip covered the frame (a text
  // or motion layer, an alpha video, a letterboxed or layer-fit clip): the project
  // background vanished for the length of the transition, and as an opaque draw it
  // also rendered BEFORE the lower channels' (transparent) clips, which then
  // landed on top of it. Where both plates are opaque, OVER is the same picture.
  // Spelled as factors, not `premultipliedAlpha`: on a NodeMaterial that flag ALSO
  // multiplies the fragment by its alpha in the shader, darkening every soft edge
  // a second time on WebGPU. The factors read the same on both backends.
  material.transparent = true;
  material.blending = THREE.CustomBlending;
  material.blendEquation = THREE.AddEquation;
  material.blendSrc = THREE.OneFactor;
  material.blendDst = THREE.OneMinusSrcAlphaFactor;
  material.blendSrcAlpha = THREE.OneFactor;
  material.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
  const mesh = sdk.createFullscreenPlane(width, height, material);
  root.add(mesh);
  return {
    material,
    mesh,
    resize(size) { sdk.replacePlaneGeometry(mesh, size.width, size.height); },
    dispose() { mesh.geometry.dispose(); material.dispose(); },
  };
}

function bindFrame(instance, frame) {
  const { previous, current } = frame;
  if (!previous.texture || !current.texture) { instance.mesh.visible = false; return false; }
  previous.mesh.visible = false;
  current.mesh.visible = false;
  instance.mesh.visible = true;
  instance.material.uniforms.uPrevious.value = previous.texture;
  instance.material.uniforms.uCurrent.value = current.texture;
  return true;
}

export const CAROUSEL_3D_PRESET = Object.freeze({
  type: '3D Carousel',
  name: '3D Carousel',
  category: 'advanced',
  description: 'Clips ride a turning 3D carousel, one panel after the other',
  defaultDuration: 0.9,
  optionDefaults: Object.freeze({
    plateFit: 'frame',
    direction: 'right',
    skew: 0,
    shear: 0,
    spacing: 70,
    radius: 1.8,
    fov: 45,
    shading: 55,
    motionBlur: 35,
    backdrop: 3,
    swingEase: 'smooth',
  }),
  optionFields: Object.freeze([
    Object.freeze({ key: 'plateFit', label: 'Turns', type: 'select', options: Object.freeze([
      Object.freeze({ value: 'frame', label: 'Whole frame' }),
      Object.freeze({ value: 'layer', label: 'Layer only' }),
    ]) }),
    Object.freeze({ key: 'direction', label: 'Direction', type: 'select', options: Object.freeze([
      Object.freeze({ value: 'right', label: 'Right' }),
      Object.freeze({ value: 'left', label: 'Left' }),
      Object.freeze({ value: 'up', label: 'Up' }),
      Object.freeze({ value: 'down', label: 'Down' }),
    ]) }),
    Object.freeze({ key: 'skew', label: 'Skew', type: 'range', min: -80, max: 80, step: 1, suffix: '°' }),
    Object.freeze({ key: 'shear', label: 'Whip shear', type: 'range', min: -100, max: 100, step: 1, suffix: '%' }),
    Object.freeze({ key: 'spacing', label: 'Panel spacing', type: 'range', min: 30, max: 130, step: 1, suffix: '°' }),
    // Radius 0 puts both panels on the same centre — they turn in place and cross
    // through each other. FOV 0 is orthographic: no perspective at all.
    Object.freeze({ key: 'radius', label: 'Radius', type: 'range', min: 0, max: 6, step: 0.05 }),
    Object.freeze({ key: 'fov', label: 'Camera FOV', type: 'range', min: 0, max: 90, step: 1, suffix: '°' }),
    Object.freeze({ key: 'shading', label: 'Side shading', type: 'range', min: 0, max: 100, step: 1, suffix: '%' }),
    Object.freeze({ key: 'motionBlur', label: 'Motion blur', type: 'range', min: 0, max: 100, step: 1, suffix: '%' }),
    Object.freeze({ key: 'backdrop', label: 'Backdrop lift', type: 'range', min: 0, max: 20, step: 0.5, suffix: '%' }),
    Object.freeze({ key: 'swingEase', label: 'Swing ease', type: 'select', options: Object.freeze([
      Object.freeze({ value: 'smooth', label: 'Smooth' }),
      Object.freeze({ value: 'back', label: 'Back (overshoot)' }),
      Object.freeze({ value: 'cubic', label: 'Cubic In-Out' }),
      Object.freeze({ value: 'linear', label: 'Linear' }),
    ]) }),
  ]),
  createInstance(context) {
    const { THREE } = context;
    const instance = makeTwoTextureInstance(context, 'carousel', CAROUSEL_FRAGMENT, {
      uPrevious: { value: null },
      uCurrent: { value: null },
      uRatio: { value: context.width / Math.max(1, context.height) },
      uRectC: { value: new THREE.Vector2(0, 0) },
      uRectH: { value: new THREE.Vector2(context.width / Math.max(1, context.height), 1) },
      uTanHF: { value: Math.tan((45 * Math.PI / 180) / 2) },
      uOrtho: { value: 0 },
      uSpacing: { value: (70 * Math.PI) / 180 },
      uRadiusMul: { value: 1.8 },
      uShade: { value: 0.55 },
      uSign: { value: 1 },
      uAxisSC: { value: new THREE.Vector2(0, 1) },
      uShear: { value: 0 },
      uTheta0: { value: 0 },
      uTheta1: { value: 0 },
      uBgLift: { value: 0.03 },
      uBackdrop: { value: 1 },
      uUseAlpha: { value: 0 },
    });
    // Premultiplied because the plates are: the carousel accumulates 16 shutter
    // samples, and averaging premultiplied colour is the only way that stays
    // correct where a layer's alpha varies. The pass blends with the shared OVER
    // (makeTwoTextureInstance); frame fit's backdrop is simply opaque colour.
    return {
      resize(size) {
        instance.resize(size);
        instance.material.uniforms.uRatio.value = size.width / Math.max(1, size.height);
      },
      render(frame) {
        if (!bindFrame(instance, frame)) return;
        const { options, rawProgress, duration } = frame;
        const u = instance.material.uniforms;
        const spacing = (finite(options.spacing, 70) * Math.PI) / 180;
        const ease = SWING_EASES[options.swingEase] || SWING_EASES.smooth;
        const blur = clamp01(finite(options.motionBlur, 35) / 100);
        const win = blur * 1.5 / (60 * Math.max(0.05, duration));
        const vertical = options.direction === 'up' || options.direction === 'down';
        // Direction picks the base spin axis and Skew tilts it from there, so skew
        // 0 is the original transition and skew ±90 on a Right turn IS the drum.
        // The drum's base is -90, not +90: the shader this replaced built the
        // vertical mode by SWAPPING the ray's x and y, and that reflection
        // conjugates a y-axis spin into a rotation about -x, not +x. Getting the
        // sign wrong here flips Up and Down.
        const tilt = ((vertical ? -90 : 0) + finite(options.skew, 0)) * Math.PI / 180;
        // Layer fit: the union of both clip boxes becomes the panel, so a text or
        // card layer turns at its own size instead of dragging the whole frame.
        const rect = layerFitRect(options.plateFit, frame, u.uRatio.value);
        u.uRectC.value.set(rect.cx, rect.cy);
        u.uRectH.value.set(rect.hx, rect.hy);
        // FOV 0 has no finite camera distance, so it switches the solve to a real
        // orthographic camera rather than dividing by a tangent of zero.
        const fov = Math.max(0, Math.min(90, finite(options.fov, 45)));
        u.uTanHF.value = Math.tan((fov * Math.PI / 180) / 2);
        u.uOrtho.value = fov <= 0 ? 1 : 0;
        u.uSpacing.value = spacing;
        // Radius 0 is legal: both panels share the pivot and turn about their own
        // centre, which is how you get them to cross instead of swing apart.
        u.uRadiusMul.value = Math.max(0, finite(options.radius, 1.8));
        u.uShade.value = clamp01(finite(options.shading, 55) / 100);
        u.uSign.value = options.direction === 'left' || options.direction === 'down' ? -1 : 1;
        u.uAxisSC.value.set(Math.sin(tilt), Math.cos(tilt));
        u.uShear.value = Math.max(-1, Math.min(1, finite(options.shear, 0) / 100));
        u.uBgLift.value = clamp01(finite(options.backdrop, 3) / 100) * 1;
        u.uTheta0.value = ease(clamp01(rawProgress - win)) * spacing;
        u.uTheta1.value = ease(clamp01(rawProgress + win)) * spacing;
        // A layer-sized panel has nothing behind it: drop the opaque backdrop and
        // let the plate's own alpha through so lower channels keep showing.
        //
        // An entrance or an exit is see-through for the same reason and then
        // some: only ONE panel carries a clip, so an opaque backdrop would black
        // out everything under this channel for the whole turn — the empty slot
        // would read as a wall rather than as the layer simply not being there.
        const seeThrough = rect.layerFit || frame.slot !== 'cross';
        u.uBackdrop.value = seeThrough ? 0 : 1;
        u.uUseAlpha.value = seeThrough ? 1 : 0;
      },
      dispose() { instance.dispose(); },
    };
  },
});

export const LOUVER_FLIP_PRESET = Object.freeze({
  type: 'Louver Flip',
  name: 'Louver Flip',
  category: 'advanced',
  description: 'Staggered venetian-blind slats flip to the next clip',
  defaultDuration: 0.85,
  optionDefaults: Object.freeze({
    slats: 7,
    stagger: 7,
    orientation: 'horizontal',
    shading: 60,
  }),
  optionFields: Object.freeze([
    Object.freeze({ key: 'slats', label: 'Slats', type: 'range', min: 3, max: 16, step: 1 }),
    Object.freeze({ key: 'stagger', label: 'Stagger', type: 'range', min: 0, max: 20, step: 1, suffix: '%' }),
    Object.freeze({ key: 'orientation', label: 'Orientation', type: 'select', options: Object.freeze([
      Object.freeze({ value: 'horizontal', label: 'Horizontal' }),
      Object.freeze({ value: 'vertical', label: 'Vertical' }),
    ]) }),
    Object.freeze({ key: 'shading', label: 'Shading', type: 'range', min: 0, max: 100, step: 1, suffix: '%' }),
  ]),
  createInstance(context) {
    const instance = makeTwoTextureInstance(context, 'louver', LOUVER_FRAGMENT, {
      uPrevious: { value: null },
      uCurrent: { value: null },
      uProgress: { value: 0 },
      uSlats: { value: 7 },
      uStagger: { value: 0.07 },
      uShadeAmt: { value: 0.6 },
      uOrient: { value: 0 },
    });
    return {
      resize(size) { instance.resize(size); },
      render(frame) {
        if (!bindFrame(instance, frame)) return;
        const u = instance.material.uniforms;
        u.uProgress.value = clamp01(frame.progress);
        u.uSlats.value = Math.round(Math.max(1, finite(frame.options.slats, 7)));
        u.uStagger.value = clamp01(finite(frame.options.stagger, 7) / 100);
        u.uShadeAmt.value = clamp01(finite(frame.options.shading, 60) / 100);
        u.uOrient.value = frame.options.orientation === 'vertical' ? 1 : 0;
      },
      dispose() { instance.dispose(); },
    };
  },
});

export const CIRCULAR_WIPE_PRESET = Object.freeze({
  type: 'Circular Wipe',
  name: 'Circular Wipe',
  category: 'advanced',
  description: 'The next clip opens through a soft circle you aim, with a gradient beam on the edge',
  defaultDuration: 2.4,
  optionDefaults: Object.freeze({
    point: Object.freeze({ x: 0, y: 42 }),
    feather: 17,
    invert: false,
    beam: true,
    beamMode: 'ring',
    beamWidth: 12,
    beamIntensity: 120,
    bloomSize: 33.5,
    bloomIntensity: 88,
    beamSpeed: -43,
    beamFade: 18,
    beamColor1: '#38d4f0',
    beamColor2: '#7b5cff',
    beamColor3: '#ff4fa3',
    beamColor4: '#ffc94d',
    parallax: true,
    incomingZoom: 0,
    incomingDrift: 22,
    outgoingPush: 21,
  }),
  optionFields: Object.freeze([
    Object.freeze({ key: 'point', label: 'Wipe point', type: 'point' }),
    // Feather is a share of the point→corner distance, so the edge keeps its
    // softness at any composition size and wherever the point sits.
    Object.freeze({ key: 'feather', label: 'Feather', type: 'range', min: 0, max: 40, step: 0.5, suffix: '%' }),
    Object.freeze({ key: 'invert', label: 'Close onto the point', type: 'switch' }),
    Object.freeze({ type: 'section', key: 'sec-beam', label: 'Gradient beam' }),
    Object.freeze({ key: 'beam', label: 'Beam on the edge', type: 'switch' }),
    Object.freeze({ key: 'beamMode', label: 'Gradient runs', type: 'select', options: Object.freeze([
      Object.freeze({ value: 'ring', label: 'Along the ring' }),
      Object.freeze({ value: 'band', label: 'Across the band' }),
    ]) }),
    Object.freeze({ key: 'beamWidth', label: 'Width', type: 'range', min: 0, max: 30, step: 0.5, suffix: '%' }),
    Object.freeze({ key: 'beamIntensity', label: 'Intensity', type: 'range', min: 0, max: 300, step: 1, suffix: '%' }),
    Object.freeze({ key: 'bloomSize', label: 'Bloom size', type: 'range', min: 0, max: 60, step: 0.5, suffix: '%' }),
    Object.freeze({ key: 'bloomIntensity', label: 'Bloom', type: 'range', min: 0, max: 200, step: 1, suffix: '%' }),
    Object.freeze({ key: 'beamSpeed', label: 'Flow speed', type: 'range', min: -200, max: 200, step: 1, suffix: '%/s' }),
    Object.freeze({ key: 'beamFade', label: 'Fade in/out', type: 'range', min: 1, max: 50, step: 1, suffix: '%' }),
    Object.freeze({ key: 'beamColor1', label: 'Colour 1', type: 'color' }),
    Object.freeze({ key: 'beamColor2', label: 'Colour 2', type: 'color' }),
    Object.freeze({ key: 'beamColor3', label: 'Colour 3', type: 'color' }),
    Object.freeze({ key: 'beamColor4', label: 'Colour 4', type: 'color' }),
    Object.freeze({ type: 'section', key: 'sec-parallax', label: 'Parallax' }),
    Object.freeze({ key: 'parallax', label: 'Parallax', type: 'switch' }),
    // Negative is a real move: the incoming plate starts pulled BACK and settles
    // forward into place, rather than easing out of a push-in. The two halves are
    // symmetric — ±200% starts the plate 3× in / 3× out.
    Object.freeze({ key: 'incomingZoom', label: 'Incoming zoom', type: 'range', min: -200, max: 200, step: 1, suffix: '%' }),
    Object.freeze({ key: 'incomingDrift', label: 'Incoming drift', type: 'range', min: 0, max: 40, step: 1, suffix: '%' }),
    Object.freeze({ key: 'outgoingPush', label: 'Outgoing push', type: 'range', min: 0, max: 40, step: 1, suffix: '%' }),
  ]),
  createInstance(context) {
    const { THREE } = context;
    const instance = makeTwoTextureInstance(context, 'circleWipe', CIRCLE_WIPE_FRAGMENT, {
      uPrevious: { value: null },
      uCurrent: { value: null },
      uProgress: { value: 0 },
      uRatio: { value: context.width / Math.max(1, context.height) },
      uCenter: { value: new THREE.Vector2(0, 0.58) },
      uMaxR: { value: 1 },
      uFeather: { value: 0.17 },
      uInvert: { value: 0 },
      uBeam: { value: 1 },
      uBeamMode: { value: 0 },
      uBeamW: { value: 0.12 },
      uBeamI: { value: 1.2 },
      uBloomW: { value: 0.335 },
      uBloomI: { value: 0.88 },
      uFlow: { value: 0 },
      uBeamFade: { value: 0.18 },
      uC0: { value: new THREE.Vector3(0.22, 0.83, 0.94) },
      uC1: { value: new THREE.Vector3(0.48, 0.36, 1) },
      uC2: { value: new THREE.Vector3(1, 0.31, 0.64) },
      uC3: { value: new THREE.Vector3(1, 0.79, 0.30) },
      uParZoom: { value: 0 },
      uParDrift: { value: 0.22 },
      uParPush: { value: 0.21 },
    });
    // Both plates and this pass are premultiplied; the pass blends with the
    // shared premultiplied OVER (see makeTwoTextureInstance).
    return {
      resize(size) {
        instance.resize(size);
        instance.material.uniforms.uRatio.value = size.width / Math.max(1, size.height);
      },
      render(frame) {
        if (!bindFrame(instance, frame)) return;
        const u = instance.material.uniforms;
        const o = frame.options || {};
        const ratio = frame.width / Math.max(1, frame.height);
        // The point is stored as percent of the composition with y counting DOWN;
        // uv counts up. It may sit outside the frame — aiming a wipe at something
        // just off-screen is a real move.
        const cx = finite(o.point?.x, 0) / 100;
        const cy = 1 - finite(o.point?.y, 42) / 100;
        u.uProgress.value = clamp01(frame.progress);
        u.uRatio.value = ratio;
        u.uCenter.value.set(cx, cy);
        // Distance to the farthest corner, in the shader's aspect-corrected units.
        // This is what makes the wipe finish exactly at the end of the transition
        // wherever the point sits.
        u.uMaxR.value = Math.hypot(
          Math.max(Math.abs(cx), Math.abs(1 - cx)) * ratio,
          Math.max(Math.abs(cy), Math.abs(1 - cy)),
        ) * 1.02;
        u.uFeather.value = Math.max(0, finite(o.feather, 17) / 100);
        u.uInvert.value = o.invert ? 1 : 0;

        u.uBeam.value = o.beam === false ? 0 : 1;
        u.uBeamMode.value = o.beamMode === 'band' ? 1 : 0;
        u.uBeamW.value = Math.max(0, finite(o.beamWidth, 12) / 100);
        u.uBeamI.value = Math.max(0, finite(o.beamIntensity, 120) / 100);
        u.uBloomW.value = Math.max(0, finite(o.bloomSize, 33.5) / 100);
        u.uBloomI.value = Math.max(0, finite(o.bloomIntensity, 88) / 100);
        u.uBeamFade.value = clamp01(finite(o.beamFade, 18) / 100);
        // Off the transition's own clock, never the wall clock: preview, scrub and
        // export must agree on the gradient's phase.
        u.uFlow.value = frame.timeSec * (finite(o.beamSpeed, -43) / 100);
        setHexVec(u.uC0.value, o.beamColor1, '38d4f0');
        setHexVec(u.uC1.value, o.beamColor2, '7b5cff');
        setHexVec(u.uC2.value, o.beamColor3, 'ff4fa3');
        setHexVec(u.uC3.value, o.beamColor4, 'ffc94d');

        const parallax = o.parallax === false ? 0 : 1;
        // Signed, and symmetric about zero: the shader starts the incoming plate at
        // scale 1 + uParZoom, so +200% opens 3× zoomed IN and -200% opens 3× OUT.
        // The negative half has to be the reciprocal — reading it as 1 + zoom the way
        // the positive half does would hit scale 0 at -100% and flip the plate past it.
        const zoomPct = finite(o.incomingZoom, 0) / 100;
        u.uParZoom.value = parallax * (zoomPct >= 0 ? zoomPct : 1 / (1 - zoomPct) - 1);
        u.uParDrift.value = parallax * Math.max(0, finite(o.incomingDrift, 22) / 100);
        u.uParPush.value = parallax * Math.max(0, finite(o.outgoingPush, 21) / 100);
      },
      dispose() { instance.dispose(); },
    };
  },
});

// ── Pixel Blocks ────────────────────────────────────────────────────────────
// Look-dev: html/pixel-blocks-transition.html. The mask maths is the lab's,
// ported verbatim: per cell `start = d + (rj − ½)·band`, a feathered front
// `f = −band/2 + t·(1 + band + lag + fade)` (the travel rule from Circular
// Wipe), a first pass to a random "residual" level and a lagged second pass
// that completes the cell, optional alpha quantisation, and a soft mask that
// is a bilinear-with-smoothstep read of the four neighbouring cell alphas.
// Colour wipe evaluates the same mask twice on two clocks (colour in, then B
// in) with its own easing per phase — easing the whole progress once gave
// phase 1 the slow start and phase 2 the tail.
//
// Every switch is a float uniform compared against .5 so the GLSL and the TSL
// twin evaluate exactly the same expressions. Plates arrive premultiplied, so
// `mix(A, B, m)` is the cross-blend and the colour is `vec4(colour, 1)`.
const PIXEL_BLOCKS_FRAGMENT = /* glsl */ `
uniform sampler2D uPrevious;
uniform sampler2D uCurrent;
uniform vec2  uRes;         // composition size, px
uniform vec2  uCell;        // cell size, px
uniform vec2  uPoint;       // radial point, uv (y up)
uniform float uT;           // phase-1 clock, eased
uniform float uT2;          // phase-2 clock (colour wipe), eased
uniform float uSoft;
uniform float uBand;
uniform float uFade;
uniform float uResidual;
uniform float uLag;
uniform float uSteps;
uniform float uSeed;
uniform float uAngle;       // radians; 0 = left→right, 90° = top→bottom
uniform float uDir;         // 0 angle, 1 radial out, 2 radial in, 3 random
uniform float uJitterBy;    // 0 cell, 1 column, 2 row
uniform float uMode;        // 0 cross, 1 appear, 2 disappear, 3 colour wipe
uniform float uDir2Rev;     // colour wipe phase 2 runs the other way
uniform float uScaleIn;
uniform vec3  uColor;
uniform float uTint;
uniform float uPix;
uniform float uPixScale;
uniform float uGap;
uniform float uRound;
uniform float uSolo;        // 0 cross, 1 entrance (no outgoing plate), 2 exit (no incoming plate)
varying vec2 vUv;

float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }

// 0..1 coordinate along the sweep for a pixel position (y up)
float dirCoord(vec2 px){
  if (uDir > 0.5 && uDir < 2.5) {
    vec2 pp = uPoint * uRes;
    vec2 far = max(pp, uRes - pp);
    float d = length(px - pp) / length(far);
    return uDir < 1.5 ? d : 1.0 - d;
  }
  vec2 dir = vec2(cos(uAngle), -sin(uAngle));
  float d = dot(px - uRes * 0.5, dir);
  float maxD = (abs(dir.x) * uRes.x + abs(dir.y) * uRes.y) * 0.5;
  return d / maxD * 0.5 + 0.5;
}

float cellAlpha(vec2 cid, float t, float phase2){
  vec2 cc = (cid + 0.5) * uCell;
  float s = uSeed * 1.37 + phase2 * 101.0;
  float rLvl = hash(cid + s + 17.1);
  float rLag = hash(cid + s + 31.7);
  vec2 jid = uJitterBy > 1.5 ? vec2(0.0, cid.y) : (uJitterBy > 0.5 ? vec2(cid.x, 0.0) : cid);
  float rj = hash(jid + s + 3.3);
  float d = uDir > 2.5 ? hash(cid + s + 9.9) : dirCoord(cc);
  if (phase2 > 0.5 && uDir2Rev > 0.5) d = 1.0 - d;
  float band = uDir > 2.5 ? 0.0 : uBand;
  float start = d + (rj - 0.5) * band;
  float fade = max(uFade, 1e-4);
  float f = -band * 0.5 + t * (1.0 + band + uLag + fade);   // feathered front travels span + padding
  float a1 = clamp((f - start) / fade, 0.0, 1.0);
  float lvl = mix(1.0, 0.15 + 0.7 * rLvl, uResidual);
  float a2 = clamp((f - start - uLag * (0.25 + 0.75 * rLag)) / fade, 0.0, 1.0);
  float a = max(a1 * lvl, a2);
  if (uSteps > 0.5) a = floor(a * uSteps + 0.5) / uSteps;
  return a;
}
// soft (bilinear-with-smoothstep) mask — reads like a blurred low-res bitmap
float softMask(vec2 g, float t, float phase2){
  vec2 gc = g - 0.5;
  vec2 i = floor(gc);
  vec2 fr = fract(gc);
  float s = max(uSoft, 1e-3);
  vec2 w = smoothstep(0.5 - 0.5 * s, 0.5 + 0.5 * s, fr);
  float a00 = cellAlpha(i, t, phase2);
  float a10 = cellAlpha(i + vec2(1.0, 0.0), t, phase2);
  float a01 = cellAlpha(i + vec2(0.0, 1.0), t, phase2);
  float a11 = cellAlpha(i + vec2(1.0, 1.0), t, phase2);
  return mix(mix(a00, a10, w.x), mix(a01, a11, w.x), w.y);
}
float roundedBox(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }

// m = the soft mask, mN = the nearest cell's alpha (drives that cell's pixelation)
void maskAt(vec2 px, float t, float phase2, out float m, out float mN){
  vec2 g = px / uCell;
  vec2 cid = floor(g);
  float aN = cellAlpha(cid, t, phase2);
  m = softMask(g, t, phase2);
  if (uGap > 0.001 || uRound > 0.001 || uScaleIn > 0.5) {
    vec2 local = fract(g) - 0.5;
    float settle = smoothstep(0.6, 0.9, aN);             // gap + rounding close as the cell completes
    float grow = uScaleIn > 0.5 ? aN : 1.0;
    float size = mix(grow * (1.0 - uGap), 1.0, settle);
    float rr = uRound * size * 0.5 * (1.0 - settle);
    float shape = 1.0;
    if (size < 0.92) {                                    // snap near-full cells shut: no hairline outlines
      float sd = roundedBox(local, vec2(size * 0.5), rr);
      float aa = 1.0 / min(uCell.x, uCell.y);
      shape = 1.0 - smoothstep(-aa, aa, sd);
    }
    m = uScaleIn > 0.5 ? shape * step(0.002, aN) : m * shape;
  }
  mN = aN;
}
vec2 pixUv(vec2 px){ vec2 cs = uCell * uPixScale; return (floor(px / cs) + 0.5) * cs / uRes; }

void main(){
  vec2 px = vUv * uRes;
  vec4 A = texture2D(uPrevious, vUv);
  vec4 Bp = texture2D(uCurrent, vUv);
  vec2 puv = pixUv(px);
  vec4 Apix = texture2D(uPrevious, puv);
  vec4 Bpix = texture2D(uCurrent, puv);
  vec4 o;
  if (uMode > 2.5) {
    float m1, n1, m2, n2;
    maskAt(px, uT, 0.0, m1, n1);
    maskAt(px, uT2, 1.0, m2, n2);
    // the incoming plate is pixelated until its cell resolves
    vec4 B = mix(Bp, Bpix, clamp(uPix * (1.0 - n2), 0.0, 1.0));
    // One-sided, the colour fills only the layer's own pixels (premultiplied)
    float cover = mix(1.0, max(A.a, Bp.a), step(0.5, uSolo));
    o = mix(mix(A, vec4(uColor, 1.0) * cover, m1), B, m2);
  } else {
    float m, n;
    maskAt(px, uT, 0.0, m, n);
    if (uMode > 1.5) {
      vec4 As = mix(A, Apix, clamp(uPix * n, 0.0, 1.0));
      float k = 1.0 - m;
      o = As * k + Bp * (1.0 - As.a * k);
    } else {
      vec4 B = mix(Bp, Bpix, clamp(uPix * (1.0 - n), 0.0, 1.0));
      if (uMode < 0.5) o = mix(A, B, m);
      else o = B * m + A * (1.0 - B.a * m);
    }
    // band tint: colour rides the half-done cells
    float band = 4.0 * m * (1.0 - m);
    o.rgb = mix(o.rgb, uColor * o.a, uTint * band);
  }
  gl_FragColor = o;
}
`;

// The lab's direction menu → (uDir, angle°). `angle` reads the option instead.
const PIXEL_BLOCKS_DIRECTIONS = Object.freeze({
  l2r: [0, 0], r2l: [0, 180], t2b: [0, 90], b2t: [0, 270], diagDR: [0, 45], diagUR: [0, 315],
  angle: [0, null], radialOut: [1, 0], radialIn: [2, 0], random: [3, 0],
});
const PIXEL_BLOCKS_MODES = Object.freeze({ cross: 0, appear: 1, disappear: 2, colour: 3 });

// The package eases its own clocks from rawProgress (the colour wipe has two of
// them), so the editor's easing selector does not apply — the "Easing" options
// replace it, like 3D Carousel's swing ease. The curves ARE the app's: names and
// control points come from easingCurves.js, so a preset ports 1:1 from the lab.
const PIXEL_BLOCKS_EASINGS = Object.freeze([
  TransitionEasing.LINEAR,
  TransitionEasing.SINE_IN, TransitionEasing.POWER1_IN, TransitionEasing.EASE_IN, TransitionEasing.POWER3_IN,
  TransitionEasing.EXPO_IN, TransitionEasing.CIRC_IN, TransitionEasing.BACK_IN, TransitionEasing.AE_IN,
  TransitionEasing.SINE_IN_OUT, TransitionEasing.POWER1_IN_OUT, TransitionEasing.EASE_IN_OUT, TransitionEasing.POWER3_IN_OUT,
  TransitionEasing.EXPO_IN_OUT, TransitionEasing.AE_SMOOTH, TransitionEasing.NATURAL,
  TransitionEasing.SINE_OUT, TransitionEasing.EASE_OUT, TransitionEasing.POWER3_OUT, TransitionEasing.EXPO_OUT, TransitionEasing.AE_OUT,
].map((value) => Object.freeze({ value, label: value })));

function cubicBezierEase(p1x, p1y, p2x, p2y) {
  const cx = 3 * p1x, bx = 3 * (p2x - p1x) - cx, ax = 1 - cx - bx;
  const cy = 3 * p1y, by = 3 * (p2y - p1y) - cy, ay = 1 - cy - by;
  const sx = (t) => ((ax * t + bx) * t + cx) * t;
  return (x) => {
    x = clamp01(x);
    let t = x;
    for (let i = 0; i < 8; i++) {
      const err = sx(t) - x;
      if (Math.abs(err) < 1e-5) break;
      const d = (3 * ax * t + 2 * bx) * t + cx;
      if (Math.abs(d) < 1e-6) break;
      t -= err / d;
    }
    t = clamp01(t);
    return ((ay * t + by) * t + cy) * t;
  };
}
const pixelBlocksEaseCache = new Map();
// The curve the editor plays for that name (appEases), not EASING_BEZIER's handles,
// which only trace most families (14.0.18).
function pixelBlocksEase(name) {
  const key = EASING_BEZIER[name] ? name : TransitionEasing.SINE_IN;
  let fn = pixelBlocksEaseCache.get(key);
  if (!fn) { const played = namedEase(key); fn = (x) => played(clamp01(x)); pixelBlocksEaseCache.set(key, fn); }
  return fn;
}

/**
 * The two mask clocks for a raw 0→1 progress. Shared with the picker tile so
 * the thumbnail and the runtime agree on when the colour lands and when B does.
 * Returns eased values; Back In dips below 0 on purpose, the shader clamps.
 */
export function pixelBlocksClocks(options, raw) {
  const o = options || {};
  const p = clamp01(raw);
  const mode = PIXEL_BLOCKS_MODES[o.mode] ?? 0;
  if (mode !== 3) return { mode, t1: pixelBlocksEase(o.easing)(p), t2: 0 };
  const s1r = Math.max(0, finite(o.colourIn, 40));
  const sHr = Math.max(0, finite(o.colourHold, 20));
  const s2r = Math.max(0, finite(o.colourOut, 40));
  const sum = Math.max(s1r + sHr + s2r, 1e-4);
  const s1 = s1r / sum, sH = sHr / sum, s2 = s2r / sum;
  const t1 = pixelBlocksEase(o.easing)(clamp01(p / Math.max(s1, 1e-4)));
  const t2 = s2 < 1e-3 ? 0 : pixelBlocksEase(o.easing2)(clamp01((p - s1 - sH) / s2));
  return { mode, t1, t2 };
}

export const PIXEL_BLOCKS_PRESET = Object.freeze({
  type: 'Pixel Blocks',
  name: 'Pixel Blocks',
  category: 'advanced',
  description: 'The next clip arrives behind a front of pixel blocks that sweeps, bursts from a point or dissolves — or a colour wipes in first',
  // The lab's "region" (blocks only over part of the frame) was deliberately NOT
  // ported — owner: "I don't need region feature … always use full".
  defaultDuration: 2.5,
  // Picking it in the transition modal starts at defaultDuration (as uploaded
  // packages do) instead of keeping the slot's current length — 1 s is far too
  // short for the sweep.
  selectAtDefaultDuration: true,
  optionDefaults: Object.freeze({
    mode: 'cross',
    easing: TransitionEasing.AE_IN,
    colour: '#ffffff',
    colourIn: 40,
    colourHold: 20,
    colourOut: 40,
    direction2: 'same',
    easing2: TransitionEasing.BACK_IN,
    direction: 'radialOut',
    point: Object.freeze({ x: 50, y: 50 }),
    angle: 30,
    band: 25,
    fade: 26,
    residual: 30,
    lag: 20,
    steps: 5,
    jitterBy: 'cell',
    seed: 7,
    columns: 150,
    cellAspect: 1,
    softness: 0,
    gap: 30,
    rounding: 0,
    scaleIn: false,
    pixelate: 70,
    pixelSize: 1,
    tint: 80,
  }),
  optionFields: Object.freeze([
    Object.freeze({ key: 'mode', label: 'What the blocks do', type: 'select', options: Object.freeze([
      Object.freeze({ value: 'cross', label: 'Cross — A → B' }),
      Object.freeze({ value: 'appear', label: 'Appear — B in over A' }),
      Object.freeze({ value: 'disappear', label: 'Disappear — A out to B' }),
      Object.freeze({ value: 'colour', label: 'Colour wipe — colour in, then B' }),
    ]) }),
    Object.freeze({ key: 'easing', label: 'Easing', type: 'select', options: PIXEL_BLOCKS_EASINGS }),
    Object.freeze({ type: 'section', key: 'sec-colour', label: 'Colour wipe' }),
    Object.freeze({ key: 'colour', label: 'Colour', type: 'color' }),
    Object.freeze({ key: 'colourIn', label: 'Colour in share', type: 'range', min: 10, max: 100, step: 5, suffix: '%' }),
    Object.freeze({ key: 'colourHold', label: 'Colour hold share', type: 'range', min: 0, max: 80, step: 5, suffix: '%' }),
    Object.freeze({ key: 'colourOut', label: 'Colour out share', type: 'range', min: 0, max: 100, step: 5, suffix: '%' }),
    Object.freeze({ key: 'direction2', label: 'Phase 2 direction', type: 'select', options: Object.freeze([
      Object.freeze({ value: 'same', label: 'Same' }),
      Object.freeze({ value: 'reverse', label: 'Reverse' }),
    ]) }),
    Object.freeze({ key: 'easing2', label: 'Phase 2 easing', type: 'select', options: PIXEL_BLOCKS_EASINGS }),
    Object.freeze({ type: 'section', key: 'sec-sweep', label: 'Sweep' }),
    Object.freeze({ key: 'direction', label: 'Direction', type: 'select', options: Object.freeze([
      Object.freeze({ value: 'l2r', label: 'Left → Right' }),
      Object.freeze({ value: 'r2l', label: 'Right → Left' }),
      Object.freeze({ value: 't2b', label: 'Top → Bottom' }),
      Object.freeze({ value: 'b2t', label: 'Bottom → Top' }),
      Object.freeze({ value: 'diagDR', label: 'Diagonal ↘' }),
      Object.freeze({ value: 'diagUR', label: 'Diagonal ↗' }),
      Object.freeze({ value: 'angle', label: 'Custom angle' }),
      Object.freeze({ value: 'radialOut', label: 'From point (radial out)' }),
      Object.freeze({ value: 'radialIn', label: 'To point (radial in)' }),
      Object.freeze({ value: 'random', label: 'Random dissolve' }),
    ]) }),
    Object.freeze({ key: 'point', label: 'Point', type: 'point' }),
    Object.freeze({ key: 'angle', label: 'Angle', type: 'range', min: 0, max: 360, step: 1, suffix: '°' }),
    Object.freeze({ key: 'band', label: 'Band width', type: 'range', min: 0, max: 150, step: 1, suffix: '%' }),
    Object.freeze({ key: 'fade', label: 'Cell fade', type: 'range', min: 0, max: 60, step: 1, suffix: '%' }),
    Object.freeze({ key: 'residual', label: 'Residual cells', type: 'range', min: 0, max: 100, step: 1, suffix: '%' }),
    Object.freeze({ key: 'lag', label: 'Residual lag', type: 'range', min: 0, max: 100, step: 1, suffix: '%' }),
    Object.freeze({ key: 'steps', label: 'Alpha steps (0 = smooth)', type: 'range', min: 0, max: 8, step: 1 }),
    Object.freeze({ key: 'jitterBy', label: 'Jitter by', type: 'select', options: Object.freeze([
      Object.freeze({ value: 'cell', label: 'Cell' }),
      Object.freeze({ value: 'column', label: 'Column' }),
      Object.freeze({ value: 'row', label: 'Row' }),
    ]) }),
    Object.freeze({ key: 'seed', label: 'Seed', type: 'range', min: 0, max: 50, step: 1 }),
    Object.freeze({ type: 'section', key: 'sec-cells', label: 'Cells' }),
    Object.freeze({ key: 'columns', label: 'Columns', type: 'range', min: 4, max: 200, step: 1 }),
    Object.freeze({ key: 'cellAspect', label: 'Cell aspect (w/h)', type: 'range', min: 0.2, max: 5, step: 0.05 }),
    Object.freeze({ key: 'softness', label: 'Softness', type: 'range', min: 0, max: 100, step: 1, suffix: '%' }),
    Object.freeze({ key: 'gap', label: 'Gap', type: 'range', min: 0, max: 60, step: 1, suffix: '%' }),
    Object.freeze({ key: 'rounding', label: 'Rounding', type: 'range', min: 0, max: 100, step: 1, suffix: '%' }),
    Object.freeze({ key: 'scaleIn', label: 'Scale-in cells', type: 'switch' }),
    Object.freeze({ type: 'section', key: 'sec-footage', label: 'Footage treatment' }),
    Object.freeze({ key: 'pixelate', label: 'Pixelate incoming', type: 'range', min: 0, max: 100, step: 1, suffix: '%',
      slotLabels: Object.freeze({ in: 'Pixelate the layer', out: 'Pixelate the layer' }) }),
    Object.freeze({ key: 'pixelSize', label: 'Pixel size (cells)', type: 'range', min: 0.25, max: 4, step: 0.25 }),
    Object.freeze({ key: 'tint', label: 'Band tint', type: 'range', min: 0, max: 100, step: 1, suffix: '%' }),
  ]),
  createInstance(context) {
    const { THREE } = context;
    const instance = makeTwoTextureInstance(context, 'pixelBlocks', PIXEL_BLOCKS_FRAGMENT, {
      uPrevious: { value: null },
      uCurrent: { value: null },
      uRes: { value: new THREE.Vector2(context.width, context.height) },
      uCell: { value: new THREE.Vector2(20, 20) },
      uPoint: { value: new THREE.Vector2(0.5, 0.5) },
      uT: { value: 0 },
      uT2: { value: 0 },
      uSoft: { value: 0 },
      uBand: { value: 0.25 },
      uFade: { value: 0.26 },
      uResidual: { value: 0.3 },
      uLag: { value: 0.2 },
      uSteps: { value: 5 },
      uSeed: { value: 7 },
      uAngle: { value: 0 },
      uDir: { value: 1 },
      uJitterBy: { value: 0 },
      uMode: { value: 0 },
      uDir2Rev: { value: 0 },
      uScaleIn: { value: 0 },
      uColor: { value: new THREE.Color(1, 1, 1) },
      uTint: { value: 0.8 },
      uPix: { value: 0.7 },
      uPixScale: { value: 1 },
      uGap: { value: 0.3 },
      uRound: { value: 0 },
      uSolo: { value: 0 },
    });
    // Both plates and this pass are premultiplied (see makeTwoTextureInstance).
    return {
      resize(size) { instance.resize(size); },
      render(frame) {
        if (!bindFrame(instance, frame)) return;
        const u = instance.material.uniforms;
        const o = frame.options || {};
        const W = frame.width;
        const H = Math.max(1, frame.height);
        u.uRes.value.set(W, H);
        const cellW = W / Math.max(1, finite(o.columns, 150));
        u.uCell.value.set(cellW, cellW / Math.max(0.05, finite(o.cellAspect, 1)));
        // The point is percent of the composition with y DOWN; uv counts up.
        u.uPoint.value.set(finite(o.point?.x, 50) / 100, 1 - finite(o.point?.y, 50) / 100);
        const { mode, t1, t2 } = pixelBlocksClocks(o, frame.rawProgress);
        u.uT.value = t1;
        u.uT2.value = t2;
        // A layer entrance is the incoming lane alone, an exit the outgoing one
        // (see LayerTransitionType); the empty lane is transparent. One-sided the
        // block modes collapse to the layer blocking in or out: Disappear on an
        // entrance would pop the layer in whole and Appear on an exit would hold
        // it to the end, so an entrance plays Appear and an exit Disappear (the
        // layer pixelates as it goes, the mirror of the entrance). Colour wipe
        // stays a colour wipe.
        u.uSolo.value = frame.slot === 'in' ? 1 : frame.slot === 'out' ? 2 : 0;
        u.uMode.value = mode === 3 ? 3 : (frame.slot === 'in' ? 1 : (frame.slot === 'out' ? 2 : mode));
        const [dir, angle] = PIXEL_BLOCKS_DIRECTIONS[o.direction] || PIXEL_BLOCKS_DIRECTIONS.radialOut;
        u.uDir.value = dir;
        u.uAngle.value = ((angle == null ? finite(o.angle, 30) : angle) * Math.PI) / 180;
        u.uJitterBy.value = o.jitterBy === 'column' ? 1 : (o.jitterBy === 'row' ? 2 : 0);
        u.uDir2Rev.value = o.direction2 === 'reverse' ? 1 : 0;
        u.uSoft.value = clamp01(finite(o.softness, 0) / 100);
        u.uBand.value = Math.max(0, finite(o.band, 25) / 100);
        u.uFade.value = Math.max(0, finite(o.fade, 26) / 100);
        u.uResidual.value = clamp01(finite(o.residual, 30) / 100);
        u.uLag.value = Math.max(0, finite(o.lag, 20) / 100);
        u.uSteps.value = Math.round(Math.max(0, finite(o.steps, 5)));
        u.uSeed.value = finite(o.seed, 7);
        u.uScaleIn.value = o.scaleIn ? 1 : 0;
        u.uGap.value = clamp01(finite(o.gap, 30) / 100);
        u.uRound.value = clamp01(finite(o.rounding, 0) / 100);
        u.uPix.value = clamp01(finite(o.pixelate, 70) / 100);
        u.uPixScale.value = Math.max(0.05, finite(o.pixelSize, 1));
        u.uTint.value = clamp01(finite(o.tint, 80) / 100);
        setHexVec(u.uColor.value, o.colour, 'ffffff');
      },
      dispose() { instance.dispose(); },
    };
  },
});

/*
 * Camera Whip — html/camera-whip-transition.html, ported verbatim.
 *
 * A whip pan is a camera ROTATION, which is why it cannot be built out of
 * Advanced Movement. Both plates hang in front of one pinhole camera that turns
 * through Θ over the transition: the outgoing plate rides 0 → Θ, the incoming
 * −Θ → 0, so they are one sweep apart on a single ramp and the cut can be hidden
 * anywhere inside it. For every output pixel the shader builds that pixel's ray,
 * turns it by the camera's current orientation and re-projects it into the plate.
 * The tan() in that round trip is the whole look: content accelerates toward the
 * frame edge, so a wide lens tears and a long lens smears almost flat. A ray whose
 * z goes negative has turned behind the camera and is genuinely empty — no edge
 * fill can invent it, which is what the `behind` flag carries.
 *
 * The blur is the camera itself: every shutter sample re-warps the plate at its
 * own instant inside the exposure, so the streaks bend with the lens and are
 * longer at the frame edge than in the middle. Rolling shutter is the same
 * angular rate offered per scanline. Both fall out of one first-order model —
 * the orientation at shutter open and the swing across it — which is why the JS
 * driver hands the shader an angle and a delta rather than an easing.
 *
 * Like 3D Carousel and Pixel Blocks, this package eases its OWN clock from
 * rawProgress (the shutter window needs the easing's derivative, which a
 * pre-eased progress cannot give), so the modal's EASE row does not apply and
 * the `easing` option replaces it.
 *
 * Every switch is a float compared against a threshold, never an int, so this
 * GLSL and the TSL twin in transitionPackageNodes.js evaluate the same
 * arithmetic. Screen and plate coordinates run Y-DOWN inside the warp, matching
 * the lab expression for expression; the two flips against three.js uv live at
 * the entry and at the texture fetch.
 */

const CAMERA_WHIP_FRAGMENT = /* glsl */ `
uniform sampler2D uPrevious;
uniform sampler2D uCurrent;
uniform float uAspect;        // composition width / height
uniform float uFocal;         // plate focal length, half-width units
uniform vec3  uK;             // pan axis: turning about it moves content along the whip
uniform vec3  uK2;            // the in-plane axis perpendicular to that
uniform vec3  uRotA;          // outgoing plate: pan, perpendicular, roll at shutter open
uniform vec3  uRotB;          // incoming plate, same clock
uniform vec3  uSweepA;        // how far those three move across one exposure
uniform vec3  uSweepB;
uniform vec3  uRS;            // rolling-shutter swing, top of frame to bottom
uniform float uFocalOut;      // output focal, carries the push
uniform float uFocalSweep;
uniform float uBias;          // -1 trailing .. +1 leading
uniform float uStreak;        // highlight accumulation exponent, minus one
uniform float uChroma;        // lateral fringing, already scaled by the motion envelope
uniform float uMix;           // 0 = outgoing, 1 = incoming
uniform float uEdge;          // 0 mirror, 1 clamp, 2 none, 3 black
uniform float uTileFade;
uniform vec4  uFoldA;         // where Mirror/Clamp fold the outgoing plate: x0, y0, x1, y1 (Y-down)
uniform vec4  uFoldB;         // the incoming plate's
uniform vec3  uFlash;         // flash tint
uniform float uFlashAmt;
uniform float uSolo;          // 0 cross, 1 entrance (no outgoing plate), 2 exit (no incoming plate)
uniform float uSamplesA;      // shutter samples this frame, per plate (1 = settled camera)
uniform float uSamplesB;
varying vec2 vUv;

const int SAMPLES = ${CAMERA_WHIP_NODE_SAMPLES};

// Interleaved gradient noise, the same per-pixel shutter phase 3D Carousel uses:
// a long smear over a finite sample count reads as a comb of ghosts, and giving
// every pixel its own offset turns that banding into grain far more cheaply than
// the sample count it would otherwise take to hide it.
float whipIgn(vec2 p){ return fract(52.9829189 * fract(0.06711056 * p.x + 0.00583715 * p.y)); }

vec2 whipMirror(vec2 q) {
  vec2 t = mod(q, 2.0);
  return mix(t, 2.0 - t, step(1.0, t));
}

// How far outside [0,1] this sample landed — 0 inside, 1 a full frame out.
float whipOutside(vec2 q) {
  vec2 d = max(vec2(0.0) - q, q - vec2(1.0));
  return clamp(max(d.x, d.y), 0.0, 1.0);
}

// Plates are premultiplied, so the ring darkening scales rgb and leaves coverage
// alone, and the empty modes write straight premultiplied black or a hole.
//
// Mirror and Clamp fold at the PICTURE's edge (the fold rect, see whipFoldRect), which
// is the plate's own edge unless the clip is letterboxed: its bars are not
// image, and a fold at the plate edge doubles them into a dark seam. A fold of
// (0, 0, 1, 1) is the plate, and the arithmetic below is then exactly q.
vec4 whipFetch(sampler2D tex, vec2 q, vec4 fold, float behind) {
  vec2 span = fold.zw - fold.xy;
  vec2 l = (q - fold.xy) / span;
  float o = max(whipOutside(l), behind);
  float mirror = step(uEdge, 0.5);
  vec2 inside = fold.xy + mix(clamp(l, 0.0005, 0.9995), whipMirror(l), mirror) * span;
  vec4 c = texture2D(tex, vec2(inside.x, 1.0 - inside.y));
  float invent = step(uEdge, 1.5);          // mirror and clamp both invent image
  c.rgb *= 1.0 - uTileFade * clamp(o * 3.0, 0.0, 1.0) * invent;
  vec4 blank = vec4(0.0, 0.0, 0.0, step(2.5, uEdge));
  return mix(c, blank, (1.0 - invent) * step(0.0001, o));
}

// Rodrigues with the angle's sine and cosine already in hand: turn the ray
// about an arbitrary axis. A diagonal whip is ONE rotation about one tilted
// axis, not a yaw stacked on a pitch.
vec3 whipTurn(vec3 v, vec3 k, float c, float s) {
  return v * c + cross(k, v) * s + k * dot(k, v) * (1.0 - c);
}

// Output pixel to plate uv, through the camera. Both are Y-DOWN here. c/s are
// cos/sin of (pan, perpendicular, roll).
vec2 whipWarp(vec2 q, vec3 c, vec3 s, float fOut, out float behind) {
  vec3 d = vec3((q.x - 0.5) * 2.0, (q.y - 0.5) * 2.0 / uAspect, fOut);
  d.xy = vec2(d.x * c.z - d.y * s.z, d.x * s.z + d.y * c.z);
  d = whipTurn(d, uK2, c.y, s.y);
  d = whipTurn(d, uK, c.x, s.x);
  behind = 1.0 - step(0.0005, d.z);
  float iz = uFocal / max(d.z, 0.0005);
  return vec2(d.x * iz * 0.5 + 0.5, d.y * iz * 0.5 * uAspect + 0.5);
}

// One plate, integrated across the exposure with n samples — the CPU sizes n
// to the smear's extent in pixels, so a settled camera runs ONE sample
// and a short smear a handful (cameraWhipSampleCount).
//
// The three camera angles move by a FIXED step from one sample to the next,
// so their sines and cosines come from one complex rotation of the previous
// pair (angle addition) instead of three sin/cos calls per sample. Fringing —
// a per-channel focal length, i.e. real lateral CA that stretches with the
// lens — samples the same ray at two more focals inside the same loop, so
// the shader holds ONE loop body per plate rather than four exposures.
//
// Accumulating in a higher power and un-powering after is what keeps
// speculars as bright lines instead of grey mush. Coverage is averaged per
// channel and the widest of the three taken, exactly as three separate
// exposures would have it.
vec4 whipPlate(sampler2D tex, vec2 q, vec3 rot, vec3 sweep, float nf, float jitter, vec4 fold) {
  int n = int(nf + 0.5);
  vec3 rs = uRS * (q.y - 0.5);
  float inv = 1.0 / max(nf - 1.0, 1.0);
  float w0 = jitter * inv - 0.5 + uBias * 0.5;
  vec3 a0 = rot + rs + sweep * w0;
  vec3 da = sweep * inv;
  vec3 c = cos(a0);
  vec3 s = sin(a0);
  vec3 cd = cos(da);
  vec3 sd = sin(da);
  float f0 = uFocalOut + uFocalSweep * w0;
  float df = uFocalSweep * inv;
  float p = 1.0 + uStreak;
  float k = uChroma * 0.05 * uFocalOut;
  bool chroma = uChroma >= 0.002;
  vec3 acc = vec3(0.0);
  vec3 cover = vec3(0.0);
  for (int i = 0; i < SAMPLES; i++) {
    if (i >= n) break;
    float f = f0 + float(i) * df;
    float behind;
    vec2 su = whipWarp(q, c, s, f, behind);
    vec4 g = whipFetch(tex, su, fold, behind);
    vec3 alpha = vec3(g.a);
    if (chroma) {
      float bR;
      float bB;
      vec2 suR = whipWarp(q, c, s, f + k, bR);
      vec2 suB = whipWarp(q, c, s, f - k, bB);
      vec4 r = whipFetch(tex, suR, fold, bR);
      vec4 b = whipFetch(tex, suB, fold, bB);
      alpha = vec3(r.a, g.a, b.a);
      g = vec4(r.r, g.g, b.b, g.a);
    }
    acc += pow(max(g.rgb, 0.0), vec3(p));
    cover += alpha;
    vec3 c1 = c * cd - s * sd;
    s = s * cd + c * sd;
    c = c1;
  }
  acc /= nf;
  cover /= nf;
  return vec4(pow(max(acc, 0.0), vec3(1.0 / p)), max(max(cover.r, cover.g), cover.b));
}

void main() {
  vec2 q = vec2(vUv.x, 1.0 - vUv.y);
  float jitter = whipIgn(gl_FragCoord.xy);
  // A layer entrance or exit has ONE plate: the other lane is a cleared target,
  // and it must contribute nothing at all — a Black edge fill on an empty lane
  // would otherwise paint a wall where the layer simply is not.
  bool hasA = uSolo < 0.5 || uSolo > 1.5;
  bool hasB = uSolo < 1.5;
  vec4 a = vec4(0.0);
  vec4 b = vec4(0.0);
  if (hasA && uMix < 0.999) a = whipPlate(uPrevious, q, uRotA, uSweepA, uSamplesA, jitter, uFoldA);
  if (hasB && uMix > 0.001) b = whipPlate(uCurrent, q, uRotB, uSweepB, uSamplesB, jitter, uFoldB);
  vec4 col = mix(a, b, uMix);
  // A lift TOWARD a colour, so a black tint darkens the join instead of blowing
  // it out — same control, both halves of the trick. One-sided, the lift lights
  // only the layer's own coverage (premultiplied): what is under it is not ours.
  float cover = mix(1.0, col.a, step(0.5, uSolo));
  col = mix(col, vec4(uFlash, 1.0) * cover, clamp(uFlashAmt, 0.0, 1.0));
  gl_FragColor = col;
}`;

const WHIP_DEG = Math.PI / 180;
const WHIP_EDGE_MODES = Object.freeze({ mirror: 0, clamp: 1, none: 2, black: 3 });
const whipSmooth = (x) => { const t = clamp01(x); return t * t * (3 - 2 * t); };
const whipBoundaryFade = (p) => whipSmooth(p / 0.1) * whipSmooth((1 - p) / 0.1);

// The whip needs the easing's DERIVATIVE, so it has to evaluate the curve itself:
// the curve the editor plays for that name (appEases — the exact family, the AE
// bezier or the mf* table), so a lab preset name ports across unchanged.
const whipEaseCache = new Map();
function whipEase(name) {
  const key = EASING_BEZIER[name] || SAMPLED_EASING_VALUES[name] ? name : TransitionEasing.AE_SMOOTH;
  let fn = whipEaseCache.get(key);
  if (!fn) {
    const played = namedEase(key);
    fn = (x) => played(clamp01(x));
    whipEaseCache.set(key, fn);
  }
  return fn;
}

// Plate focal in half-width units. 90 degrees of horizontal field is f = 1.
const whipFocal = (o) => 1 / Math.tan((Math.max(4, finite(o.fov, 62)) * WHIP_DEG) / 2);

// The whip axis as a ROTATION axis: turning about k moves content along the
// screen direction (cos, sin). k2 is the perpendicular one, which only the
// settle shake uses. Screen y runs down, matching the warp.
function whipAxes(o) {
  const a = finite(o.axis, 0) * WHIP_DEG;
  const dx = Math.cos(a);
  const dy = -Math.sin(a);
  return { k: [-dy, dx, 0], k2: [dx, dy, 0] };
}

// The frame's own angular extent along the whip axis. Measuring travel in these
// units is what makes "100%" mean the same clearance at any lens, axis or aspect:
// at 100% the outgoing frame has exactly left the screen when the whip ends.
function whipSweep(o, aspect) {
  const a = finite(o.axis, 0) * WHIP_DEG;
  const half = Math.abs(Math.cos(a)) + Math.abs(Math.sin(a)) / Math.max(aspect, 1e-3);
  return 2 * Math.atan(half / whipFocal(o)) * (finite(o.travel, 110) / 100);
}

// Camera orientation for one plate at progress p: [pan, perpendicular, roll].
// Both plates read the SAME clock — there is only one camera.
function whipCamAt(o, p, isA, aspect, durSec) {
  const e = whipEase(o.easing)(clamp01(p));
  const theta = whipSweep(o, aspect);
  let pan = isA ? e * theta : (e - 1) * theta;
  let perp = 0;
  let roll = (isA ? e : e - 1) * finite(o.roll, 0) * WHIP_DEG;

  const shake = Math.max(0, finite(o.shake, 0));
  if (shake > 0) {
    // A damped ring around the cut, in SECONDS so the rate is honest Hz, and on
    // both plates equally: the hand shakes the camera, not the footage. A pure
    // function of progress, so scrub, preview and export cannot disagree.
    const qs = (p - clamp01(finite(o.cutAt, 50) / 100)) * durSec;
    const env = Math.exp(-Math.max(0.1, finite(o.shakeDecay, 7)) * Math.abs(qs)) * (qs < 0 ? 0.35 : 1);
    const amp = (shake / 100) * WHIP_DEG * env * whipBoundaryFade(p);
    const w = 2 * Math.PI * Math.max(0.1, finite(o.shakeRate, 9)) * qs;
    pan += amp * Math.sin(w);
    perp += amp * 0.62 * Math.sin(w * 1.37 + 1.1);
    roll += amp * 0.4 * Math.sin(w * 0.73 + 2.2);
  }
  return [pan, perp, roll];
}

function whipRateAt(o, p, aspect, durSec) {
  const d = 0.0008;
  const a = whipCamAt(o, p + d, true, aspect, durSec);
  const b = whipCamAt(o, p - d, true, aspect, durSec);
  return Math.hypot(a[0] - b[0], a[1] - b[1]) / (2 * d * Math.max(0.01, durSec));
}

/*
 * One envelope for everything that is a CONSEQUENCE of moving — the lens
 * fringing and the push both ride it.
 *
 * Anything that does not reach zero where the camera is at rest leaves the
 * settled frame altered, and a transition may never do that: at progress 0 and
 * 1 the plate has to be the clip itself. Normalising by the peak is what makes
 * "Fringing 30" mean 30 at the peak; subtracting the endpoint floor is what
 * pins curves like Circ Smooth and Back — which arrive still moving — to zero
 * there. Linear moves at a constant rate, where there is no floor to subtract
 * and the honest answer is that the camera never stops.
 */
const whipEnvCache = new Map();
function whipEnvNorm(o, aspect, durSec) {
  const sig = [o.easing, o.travel, o.fov, o.axis, o.roll, o.shake, o.shakeRate,
    o.shakeDecay, o.cutAt, aspect, durSec].join('|');
  let got = whipEnvCache.get(sig);
  if (!got) {
    let peak = 0;
    for (let i = 0; i <= 96; i += 1) peak = Math.max(peak, whipRateAt(o, i / 96, aspect, durSec));
    peak = peak || 1;
    const floor = Math.max(whipRateAt(o, 0, aspect, durSec), whipRateAt(o, 1, aspect, durSec)) / peak;
    got = { peak, floor: floor >= 0.98 ? 0 : floor };
    if (whipEnvCache.size > 32) whipEnvCache.clear();
    whipEnvCache.set(sig, got);
  }
  return got;
}
function whipEnvelope(o, p, aspect, durSec) {
  const { peak, floor } = whipEnvNorm(o, aspect, durSec);
  return clamp01((clamp01(whipRateAt(o, p, aspect, durSec) / peak) - floor) / (1 - floor)) * whipBoundaryFade(p);
}

/*
 * How many shutter samples one plate needs THIS frame.
 *
 * The cost of the whip is the exposure loop, and most of its frames do not
 * need the full count: a settled camera is one sample, and a smear a few
 * pixels long needs a few. What decides the count is the smear's extent on
 * screen, in pixels — pan and tilt through the lens (content moves f·tan θ,
 * steepest at the frame edge where the slope is f·sec² = f + 1/f), roll and
 * the push around the frame's half-diagonal. With the per-pixel shutter dither
 * a step of a few pixels between samples reads as grain, not as ghosts, so the
 * count is the extent over that step, capped at CAMERA_WHIP_NODE_SAMPLES —
 * which a full-frame whip reaches long before its peak, so the look there is
 * the same 32-sample one as before.
 */
export const CAMERA_WHIP_PX_PER_SAMPLE = 4;
export function cameraWhipSampleCount(v, sweep, width, height, cap = CAMERA_WHIP_NODE_SAMPLES, pxPerSample = CAMERA_WHIP_PX_PER_SAMPLE) {
  const halfW = Math.max(1, width) / 2;
  const halfH = Math.max(1, height) / 2;
  const half = Math.max(halfW, halfH);
  const diag = Math.hypot(halfW, halfH);
  const f = Math.max(1e-3, v.focal);
  const slope = f + 1 / f;
  const px = (Math.abs(sweep[0]) + Math.abs(sweep[1])) * slope * half
    + Math.abs(sweep[2]) * diag
    + (Math.abs(v.focalSweep) / f) * diag;
  if (!(px > 0.5)) return 1;
  return Math.max(2, Math.min(cap, Math.ceil(px / pxPerSample)));
}

/**
 * Everything the shader and the picker tile need for one frame of the whip.
 * Exported so the thumbnail painter and the runtime cannot drift apart.
 */
export function cameraWhipFrame(options, raw, aspect, durationSec) {
  const o = options || {};
  const p = clamp01(raw);
  const dur = Math.max(0.05, finite(durationSec, 0.5));
  const ar = Math.max(0.05, finite(aspect, 16 / 9));

  // Half the exposure and half the sensor readout, both expressed in progress.
  const fps = Math.max(1, finite(o.fps, 30));
  // Shrink the exposure/readout at the boundaries so even linear easings land
  // on the unchanged source frame. No samples may look beyond the transition.
  const boundary = Math.min(p, 1 - p);
  const half = Math.min(boundary, ((clamp01(finite(o.shutter, 255) / 360) / fps) / dur) / 2);
  const readout = ((finite(o.rollingShutter, 0) / 100 / fps) / dur) / 2;
  const rsHalf = Math.sign(readout) * Math.min(boundary, Math.abs(readout));

  const cam = (q, isA) => whipCamAt(o, q, isA, ar, dur);
  const rotA = cam(p, true);
  const rotB = cam(p, false);
  const aPlus = cam(p + half, true);
  const aMinus = cam(p - half, true);
  const bPlus = cam(p + half, false);
  const bMinus = cam(p - half, false);
  const rsPlus = cam(p + rsHalf, true);
  const rsMinus = cam(p - rsHalf, true);

  const env = whipEnvelope(o, p, ar, dur);
  const focalOut = (q) => whipFocal(o) * (1 + (finite(o.push, 0) / 100) * whipEnvelope(o, q, ar, dur));
  const fOut = whipFocal(o) * (1 + (finite(o.push, 0) / 100) * env);

  // Cross-blend centred on the cut. At width 0 it is a hard cut on one frame.
  const cut = clamp01(finite(o.cutAt, 50) / 100);
  const w = Math.min(Math.max(0, finite(o.blendWindow, 8)) / 100, 2 * cut, 2 * (1 - cut));
  const u = w > 0 ? clamp01((p - (cut - w / 2)) / w) : (p >= cut ? 1 : 0);

  // The flash is a gaussian on the cut with its own endpoints subtracted, so
  // even a 100%-wide flash leaves the first and last frame clean.
  const fw = Math.max(0.02, finite(o.flashWidth, 28) / 100) / 2;
  const bell = (q) => Math.exp(-(((q - cut) / fw) ** 2));
  const bellFloor = Math.max(bell(0), bell(1));
  const flash = clamp01(Math.max(0, finite(o.flash, 0)) / 100)
    * clamp01((bell(p) - bellFloor) / Math.max(1 - bellFloor, 1e-4));

  return {
    ...whipAxes(o),
    rotA,
    rotB,
    sweepA: rotA.map((v, i) => aPlus[i] - aMinus[i]),
    sweepB: rotB.map((v, i) => bPlus[i] - bMinus[i]),
    rs: rotA.map((v, i) => rsPlus[i] - rsMinus[i]),
    focal: whipFocal(o),
    focalOut: fOut,
    focalSweep: focalOut(p + half) - focalOut(p - half),
    mix: u * u * (3 - 2 * u),
    env,
    flash,
    theta: whipSweep(o, ar),
  };
}

/*
 * Where Mirror and Clamp fold one plate: x0, y0, x1, y1 in the shader's Y-down
 * plate uv.
 *
 * The plate's own edge, unless the clip is letterboxed. Fit-contain paints a
 * mismatched clip's bars opaque black INSIDE the plate (a 1344×768 clip in a
 * 16:9 frame: ~0.8% a side), and a fold at the plate edge doubles them into a
 * dark seam that rides the whip across the frame. The picture's own edge is the
 * seamless fold — on a side where the plane itself reaches the frame edge, so
 * that everything between picture and plate edge IS bar. A layer smaller than
 * the frame keeps folding at the plate edge: its margin is see-through, not bar.
 *
 * The fold hands over from the plate edge to the picture edge as the plate
 * leaves rest, done by the time it has moved one bar width: a settled frame is
 * the clip itself, bars included, and while the hand-over runs the bar is still
 * sitting on the frame edge where it always was.
 */
const WHIP_FULL_FOLD = Object.freeze([0, 0, 1, 1]);
export function cameraWhipFoldRect(layer, rot, focal) {
  const pic = layer?.pictureBounds;
  const box = layer?.bounds;
  if (!pic || !box) return WHIP_FULL_FOLD;
  const reach = 1e-3;
  // One plate texel inside the picture, so the linear fetch at the fold never
  // reaches the bar's texels. The capture target is drawing-buffer sized.
  const width = layer.texture?.image?.width || 1920;
  const height = layer.texture?.image?.height || 1080;
  const tx = 1 / Math.max(1, width);
  const ty = 1 / Math.max(1, height);
  const x0 = box.minX <= -1 + reach && pic.minX > -1 + reach ? (pic.minX + 1) / 2 + tx : 0;
  const x1 = box.maxX >= 1 - reach && pic.maxX < 1 - reach ? (pic.maxX + 1) / 2 - tx : 1;
  const y0 = box.maxY >= 1 - reach && pic.maxY < 1 - reach ? (1 - pic.maxY) / 2 + ty : 0;
  const y1 = box.minY <= -1 + reach && pic.minY > -1 + reach ? (1 - pic.minY) / 2 - ty : 1;
  if (!(x1 - x0 > 0.1) || !(y1 - y0 > 0.1)) return WHIP_FULL_FOLD;
  const barPx = Math.max(x0 * width, (1 - x1) * width, y0 * height, (1 - y1) * height);
  if (!(barPx > 0)) return WHIP_FULL_FOLD;
  // How far the frame edge of this plate has travelled from rest, in px: pan
  // and tilt through the lens (steepest at the edge, f + 1/f), roll about the
  // half-diagonal.
  const halfW = Math.max(1, width) / 2;
  const halfH = Math.max(1, height) / 2;
  const f = Math.max(1e-3, focal);
  const movedPx = (Math.abs(rot[0]) + Math.abs(rot[1])) * (f + 1 / f) * Math.max(halfW, halfH)
    + Math.abs(rot[2]) * Math.hypot(halfW, halfH);
  const k = clamp01(movedPx / Math.max(1, barPx));
  if (!(k > 0)) return WHIP_FULL_FOLD;
  return [x0 * k, y0 * k, 1 - (1 - x1) * k, 1 - (1 - y1) * k];
}

export const CAMERA_WHIP_PRESET = Object.freeze({
  type: 'Camera Whip',
  name: 'Camera Whip',
  category: 'advanced',
  description: 'One camera whips off the outgoing clip and lands on the next, smeared by its own shutter',
  defaultDuration: 0.5,
  optionDefaults: Object.freeze({
    easing: TransitionEasing.AE_SMOOTH,
    travel: 110,
    axis: 225,
    roll: 10,
    cutAt: 50,
    blendWindow: 8,
    fov: 62,
    push: 7,
    fringing: 0,
    shutter: 255,
    fps: 30,
    bias: 0,
    streak: 45,
    rollingShutter: 0,
    shake: 0,
    shakeRate: 9,
    shakeDecay: 7,
    flash: 0,
    flashWidth: 28,
    flashTint: '#ffffff',
    edgeMode: 'mirror',
    tileFade: 35,
  }),
  optionFields: Object.freeze([
    Object.freeze({ key: 'axis', label: 'Direction', type: 'range', min: 0, max: 359, step: 1, suffix: '°' }),
    Object.freeze({ key: 'travel', label: 'Travel', type: 'range', min: 20, max: 220, step: 5, suffix: '%' }),
    Object.freeze({ key: 'easing', label: 'Easing', type: 'select', options: PIXEL_BLOCKS_EASINGS }),
    Object.freeze({ key: 'roll', label: 'Camera roll', type: 'range', min: -60, max: 60, step: 1, suffix: '°' }),
    Object.freeze({ key: 'cutAt', label: 'Cut at', type: 'range', min: 5, max: 95, step: 1, suffix: '%' }),
    Object.freeze({ key: 'blendWindow', label: 'Blend window', type: 'range', min: 0, max: 60, step: 1, suffix: '%' }),
    Object.freeze({ type: 'section', key: 'sec-lens', label: 'Lens' }),
    Object.freeze({ key: 'fov', label: 'Field of view', type: 'range', min: 12, max: 130, step: 1, suffix: '°' }),
    Object.freeze({ key: 'push', label: 'Push', type: 'range', min: -60, max: 80, step: 1, suffix: '%' }),
    Object.freeze({ key: 'fringing', label: 'Fringing', type: 'range', min: 0, max: 100, step: 1, suffix: '%' }),
    Object.freeze({ type: 'section', key: 'sec-shutter', label: 'Shutter' }),
    Object.freeze({ key: 'shutter', label: 'Shutter angle', type: 'range', min: 0, max: 360, step: 5, suffix: '°' }),
    Object.freeze({ key: 'fps', label: 'Frame rate', type: 'select', options: Object.freeze([
      Object.freeze({ value: 24, label: '24 fps' }),
      Object.freeze({ value: 25, label: '25 fps' }),
      Object.freeze({ value: 30, label: '30 fps' }),
      Object.freeze({ value: 50, label: '50 fps' }),
      Object.freeze({ value: 60, label: '60 fps' }),
    ]) }),
    Object.freeze({ key: 'streak', label: 'Highlight streak', type: 'range', min: 0, max: 100, step: 1, suffix: '%' }),
    Object.freeze({ key: 'bias', label: 'Trail bias', type: 'range', min: -100, max: 100, step: 5, suffix: '%' }),
    Object.freeze({ type: 'section', key: 'sec-sensor', label: 'Sensor & hand' }),
    Object.freeze({ key: 'rollingShutter', label: 'Rolling shutter', type: 'range', min: -100, max: 100, step: 5, suffix: '%' }),
    // Hundredths of a degree, the lab's own scale — 100 is a one-degree ring.
    Object.freeze({ key: 'shake', label: 'Settle shake', type: 'range', min: 0, max: 400, step: 5 }),
    Object.freeze({ key: 'shakeRate', label: 'Shake rate', type: 'range', min: 1, max: 24, step: 0.5, suffix: 'hz' }),
    Object.freeze({ key: 'shakeDecay', label: 'Shake decay', type: 'range', min: 1, max: 30, step: 0.5 }),
    Object.freeze({ type: 'section', key: 'sec-flash', label: 'Flash' }),
    Object.freeze({ key: 'flash', label: 'Amount', type: 'range', min: 0, max: 150, step: 5, suffix: '%' }),
    Object.freeze({ key: 'flashWidth', label: 'Width', type: 'range', min: 4, max: 100, step: 2, suffix: '%' }),
    Object.freeze({ key: 'flashTint', label: 'Tint', type: 'color' }),
    Object.freeze({ type: 'section', key: 'sec-edges', label: 'Edges' }),
    Object.freeze({ key: 'edgeMode', label: 'Off-frame', type: 'select', options: Object.freeze([
      Object.freeze({ value: 'mirror', label: 'Mirror tile' }),
      Object.freeze({ value: 'clamp', label: 'Clamp' }),
      Object.freeze({ value: 'none', label: 'Transparent' }),
      Object.freeze({ value: 'black', label: 'Black' }),
    ]) }),
    Object.freeze({ key: 'tileFade', label: 'Tile fade', type: 'range', min: 0, max: 100, step: 5, suffix: '%' }),
  ]),
  createInstance(context) {
    const { THREE } = context;
    const instance = makeTwoTextureInstance(context, 'cameraWhip', CAMERA_WHIP_FRAGMENT, {
      uPrevious: { value: null },
      uCurrent: { value: null },
      uAspect: { value: 16 / 9 },
      uFocal: { value: 1.6 },
      uK: { value: new THREE.Vector3(0, 1, 0) },
      uK2: { value: new THREE.Vector3(1, 0, 0) },
      uRotA: { value: new THREE.Vector3() },
      uRotB: { value: new THREE.Vector3() },
      uSweepA: { value: new THREE.Vector3() },
      uSweepB: { value: new THREE.Vector3() },
      uRS: { value: new THREE.Vector3() },
      uFocalOut: { value: 1.6 },
      uFocalSweep: { value: 0 },
      uBias: { value: 0 },
      uStreak: { value: 1.35 },
      uChroma: { value: 0 },
      uMix: { value: 0 },
      uEdge: { value: 0 },
      uTileFade: { value: 0.35 },
      uFoldA: { value: new THREE.Vector4(0, 0, 1, 1) },
      uFoldB: { value: new THREE.Vector4(0, 0, 1, 1) },
      uFlash: { value: new THREE.Vector3(1, 1, 1) },
      uFlashAmt: { value: 0 },
      uSolo: { value: 0 },
      uSamplesA: { value: 1 },
      uSamplesB: { value: 1 },
    });
    // Both plates and this pass are premultiplied; every slot — cross, entrance,
    // exit — blends with the shared premultiplied OVER (see makeTwoTextureInstance).
    return {
      resize(size) { instance.resize(size); },
      render(frame) {
        if (!bindFrame(instance, frame)) return;
        const u = instance.material.uniforms;
        const o = frame.options || {};
        const aspect = Math.max(0.05, frame.width / Math.max(1, frame.height));
        const v = cameraWhipFrame(o, frame.rawProgress, aspect, frame.duration);
        // A layer entrance is the incoming lane on its own, an exit the outgoing
        // one (see LayerTransitionType). The pass is then see-through, like the
        // 3D Carousel's one-panel turn: the empty lane draws nothing, so lower
        // channels keep showing where the layer is not.
        const solo = frame.slot === 'in' ? 1 : frame.slot === 'out' ? 2 : 0;
        u.uSolo.value = solo;
        u.uSamplesA.value = cameraWhipSampleCount(v, v.sweepA, frame.width, frame.height);
        u.uSamplesB.value = cameraWhipSampleCount(v, v.sweepB, frame.width, frame.height);
        u.uAspect.value = aspect;
        u.uFocal.value = v.focal;
        u.uK.value.set(v.k[0], v.k[1], v.k[2]);
        u.uK2.value.set(v.k2[0], v.k2[1], v.k2[2]);
        u.uRotA.value.set(v.rotA[0], v.rotA[1], v.rotA[2]);
        u.uRotB.value.set(v.rotB[0], v.rotB[1], v.rotB[2]);
        u.uSweepA.value.set(v.sweepA[0], v.sweepA[1], v.sweepA[2]);
        u.uSweepB.value.set(v.sweepB[0], v.sweepB[1], v.sweepB[2]);
        u.uRS.value.set(v.rs[0], v.rs[1], v.rs[2]);
        u.uFocalOut.value = v.focalOut;
        u.uFocalSweep.value = v.focalSweep;
        u.uBias.value = clamp01(Math.abs(finite(o.bias, 0)) / 100) * Math.sign(finite(o.bias, 0));
        u.uStreak.value = clamp01(finite(o.streak, 45) / 100) * 3;
        // Fringing rides the motion envelope: it is a consequence of moving, so
        // it is gone wherever the camera is at rest.
        u.uChroma.value = clamp01(finite(o.fringing, 0) / 100) * v.env;
        u.uMix.value = v.mix;
        u.uEdge.value = WHIP_EDGE_MODES[o.edgeMode] ?? 0;
        u.uTileFade.value = clamp01(finite(o.tileFade, 35) / 100);
        // Only the modes that invent image fold; Transparent and Black keep
        // the plate as it is, bars and all.
        const invents = u.uEdge.value < 1.5;
        const foldA = invents ? cameraWhipFoldRect(frame.previous, v.rotA, v.focal) : WHIP_FULL_FOLD;
        const foldB = invents ? cameraWhipFoldRect(frame.current, v.rotB, v.focal) : WHIP_FULL_FOLD;
        u.uFoldA.value.set(foldA[0], foldA[1], foldA[2], foldA[3]);
        u.uFoldB.value.set(foldB[0], foldB[1], foldB[2], foldB[3]);
        setHexVec(u.uFlash.value, o.flashTint, 'ffffff');
        u.uFlashAmt.value = v.flash;
      },
      dispose() { instance.dispose(); },
    };
  },
});

// ── Zoom Ruler ──────────────────────────────────────────────────────────────
// Look-dev: html/zoom-ruler-transition-lab.html. The Shape Rulers box is the clip
// mask: the outgoing clip outside it, the incoming one inside, until the box has
// cleared the frame. Ruler geometry is shared with the overlay effect
// (shapeRulersGlsl.js), so the two look identical.
//
// The reference (an After Effects edit, 2880×1620 @ 30 fps) was measured frame by
// frame: the box = a fixed start square + a scale × a base rect, and the scale
// follows ZOOM_RULER_REF_SCALE — a fast open (f0→f20), a slow breathing hold, then
// an accelerating burst that clears the frame at f48. The lab matched it within
// 0.5 % on every sampled frame. The package eases its own clock from rawProgress,
// so the editor's easing selector does not apply (like Pixel Blocks).
const ZOOM_RULER_REF_SCALE = Object.freeze([
  0, 0.029, 0.091, 0.187, 0.305, 0.416, 0.508, 0.584, 0.646, 0.699, 0.745, 0.785, 0.821, 0.852,
  0.880, 0.905, 0.928, 0.949, 0.967, 0.984, 1.0, 1.014, 1.027, 1.039, 1.050, 1.062, 1.073, 1.085,
  1.098, 1.112, 1.126, 1.143, 1.160, 1.180, 1.201, 1.225, 1.252, 1.282, 1.317, 1.356, 1.402,
  1.455, 1.519, 1.596, 1.693, 1.819, 1.991, 2.207, 2.49,
]);
// 0..1 with 1 = the box has cleared the frame; the hold plateau sits at frame 20.
const ZOOM_RULER_REF_U = ZOOM_RULER_REF_SCALE.map((v) => v / ZOOM_RULER_REF_SCALE[ZOOM_RULER_REF_SCALE.length - 1]);
const ZOOM_RULER_REF_HOLD = ZOOM_RULER_REF_U[20];

// Fritsch–Carlson monotone cubic through the measured frames — no overshoot
// between samples, so the box never shrinks on the way out.
const zoomRulerRefCurve = (() => {
  const y = ZOOM_RULER_REF_U;
  const n = y.length;
  const h = 1 / (n - 1);
  const d = [];
  for (let i = 0; i < n - 1; i++) d.push((y[i + 1] - y[i]) / h);
  const m = [d[0]];
  for (let i = 1; i < n - 1; i++) m.push(d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2);
  m.push(d[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const sq = a * a + b * b;
    if (sq > 9) { const k = 3 / Math.sqrt(sq); m[i] = k * a * d[i]; m[i + 1] = k * b * d[i]; }
  }
  return (x) => {
    const xc = clamp01(x);
    const i = Math.min(n - 2, Math.floor(xc / h));
    const t = (xc - i * h) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * y[i] + (t3 - 2 * t2 + t) * h * m[i]
      + (-2 * t3 + 3 * t2) * y[i + 1] + (t3 - t2) * h * m[i + 1];
  };
})();

// The app's bezier catalogue names (easingCurves.js); each plays the curve the
// editor plays for that name (appEases), not the traced handles.
const ZOOM_RULER_EASINGS = Object.freeze(Object.keys(EASING_BEZIER)
  .map((value) => Object.freeze({ value, label: value })));
const zoomRulerEaseCache = new Map();
function zoomRulerEase(name) {
  let fn = zoomRulerEaseCache.get(name);
  if (!fn) { const played = namedEase(name); fn = (x) => played(clamp01(x)); zoomRulerEaseCache.set(name, fn); }
  return fn;
}
const ZOOM_RULER_SHAPES = Object.freeze({
  square: 0, circle: 1, diamond: 2, squareOutline: 3, circleOutline: 4, cross: 5, bracket: 6, none: 7,
});

/**
 * Box, zoom and fades for a raw 0→1 progress, in pixels of a width × height
 * frame with y UP (shader space). Shared with the picker tile so the thumbnail
 * and the runtime agree. Sizes are authored at 1080p and scale with the short side.
 */
export function zoomRulerFrame(options, rawProgress, width, height) {
  const o = options || {};
  const W = Math.max(1, finite(width, 1920));
  const H = Math.max(1, finite(height, 1080));
  const k = Math.min(W, H) / 1080;
  const p = clamp01(finite(rawProgress, 0));
  let u;
  if (EASING_BEZIER[o.curve]) {
    u = zoomRulerEase(o.curve)(p);
  } else {
    // Reference: the measured curve, with the hold plateau moved to Hold size by a
    // power remap — the shape (open, breathe, burst) survives any size.
    const hold = Math.max(0.05, Math.min(0.95, finite(o.holdSize, 40) / 100));
    u = Math.pow(Math.max(0, zoomRulerRefCurve(p)), Math.log(hold) / Math.log(ZOOM_RULER_REF_HOLD));
  }
  const cx = (finite(o.point?.x, 50) / 100) * W;
  const cy = (1 - finite(o.point?.y, 50) / 100) * H;
  const rulers = o.rulers !== false;
  const shape = ZOOM_RULER_SHAPES[o.markShape] ?? 0;
  const lineW = Math.max(0, finite(o.lineWidth, 1.5)) * k;
  const markW = Math.max(0, finite(o.markWidth, 15)) * k;
  const markH = Math.max(0, finite(o.markHeight, 15)) * k;
  const gapX = finite(o.spacingX, 0) * k;
  const gapY = finite(o.spacingY, 0) * k;
  const feather = Math.max(0, finite(o.feather, 0)) * k;
  // At u = 1 the mask (plus its feather) AND the rulers (mask + spacing, plus the
  // marks) must all sit outside the frame — whichever needs more.
  const markR = (shape === 7 ? 0 : Math.hypot(markW, markH) / 2) + lineW + 2;
  const mX = Math.max(feather / 2 + 1, rulers ? markR + gapX : 0);
  const mY = Math.max(feather / 2 + 1, rulers ? markR + gapY : 0);
  let aspect = W / H;
  if (o.boxShape === 'reference') aspect = 1.89;
  else if (o.boxShape === 'square') aspect = 1;
  else if (o.boxShape === 'custom') aspect = Math.max(0.2, Math.min(5, finite(o.boxRatio, 1.5)));
  // box = start square + span·(aspect, 1)·u, span just big enough to clear the frame
  const st = Math.max(0, finite(o.startSize, 21)) * k;
  const needX = Math.max(cx, W - cx) + mX;
  const needY = Math.max(cy, H - cy) + mY;
  const span = Math.max((needX - st) / aspect, needY - st, 0);
  const hx = Math.max(0, st + span * aspect * u);
  const hy = Math.max(0, st + span * u);
  const z = Math.max(0, Math.min(60, finite(o.zoom, 10))) / 100;
  let zoomB = 1;
  if (z > 0) {
    const ez = EASING_BEZIER[o.zoomEasing] ? zoomRulerEase(o.zoomEasing)(p) : u;
    zoomB = o.zoomDirection === 'settle' ? 1 + z * (1 - ez) : 1 - z * (1 - ez);
  }
  const fadeShare = Math.max(0, Math.min(100, finite(o.fadeIn, 4))) / 100;
  const fade = fadeShare > 0 ? clamp01(p / fadeShare) : 1;
  return {
    k, p, u, cx, cy, hx, hy,
    rx: Math.max(0.5, hx + gapX), ry: Math.max(0.5, hy + gapY),
    zoomB: Math.max(0.05, zoomB), fade, feather, rulers, shape, lineW, markW, markH,
  };
}

const ZOOM_RULER_FRAGMENT = /* glsl */ `
uniform sampler2D uPrevious;
uniform sampler2D uCurrent;
uniform vec2  uRes;       // frame, px
uniform vec2  uC;         // box centre, px (y up)
uniform vec2  uMH;        // mask half size, px
uniform vec2  uH;         // ruler box half size = mask + spacing, px
uniform float uFeather;   // px
uniform float uMaskIn;    // the reveal's own fade-in (0 at the first frame)
uniform float uZoomB;     // incoming plate scale about the box centre
uniform float uAlpha;     // rulers: fade-in x on/off
uniform float uLineW;
uniform float uLineA;
uniform float uExt;
uniform float uDash;
uniform vec3  uLineCol;
uniform vec2  uHS;        // mark half size
uniform float uHR;
uniform float uHShape;
uniform float uHStroke;
uniform float uMid;
uniform vec3  uHCol;
varying vec2 vUv;
${SHAPE_RULERS_GLSL}
// Mirror-tiled read: a plate pushed back past 1:1 never shows an edge.
vec2 zrMirror(vec2 uv) { return 1.0 - abs(1.0 - mod(uv, 2.0)); }
void main() {
  vec2 px = vUv * uRes;
  vec4 A = texture2D(uPrevious, vUv);
  vec4 B = texture2D(uCurrent, zrMirror((uC + (px - uC) / uZoomB) / uRes));
  float sd = srSdBox(px - uC, uMH, 0.0);
  float m = uFeather > 0.5
    ? 1.0 - smoothstep(-0.5 * uFeather, 0.5 * uFeather, sd)
    : clamp(0.5 - sd, 0.0, 1.0);
  // Plates are premultiplied, so mixing the whole vec4 IS the cross-blend.
  vec4 o = mix(A, B, m * uMaskIn);
  if (uAlpha > 0.001) {
    vec2 cov = srCoverage(px - uC, uH, uLineW, uExt, uDash, uHShape, uHS, uHR, uHStroke, uMid) * uAlpha;
    float l = cov.x * uLineA;
    o = o * (1.0 - l) + vec4(uLineCol * l, l);
    o = o * (1.0 - cov.y) + vec4(uHCol * cov.y, cov.y);
  }
  gl_FragColor = o;
}
`;

export const ZOOM_RULER_PRESET = Object.freeze({
  type: 'Zoom Ruler',
  name: 'Zoom Ruler',
  category: 'advanced',
  description: 'The next clip opens inside a growing ruler box — full-frame guides and corner marks — with an optional zoom',
  defaultDuration: 1.6,
  optionDefaults: Object.freeze({
    point: Object.freeze({ x: 50, y: 50 }),
    curve: 'reference',
    holdSize: 40,
    startSize: 21,
    boxShape: 'frame',
    boxRatio: 1.5,
    feather: 0,
    zoom: 10,
    zoomDirection: 'in',
    zoomEasing: 'follow',
    rulers: true,
    fadeIn: 4,
    spacingX: 0,
    spacingY: 0,
    lineColor: '#ffffff',
    lineOpacity: 90,
    lineWidth: 1.5,
    extend: 'frame',
    extendLength: 90,
    dash: 0,
    markShape: 'square',
    markColor: '#ffffff',
    markWidth: 15,
    markHeight: 15,
    markRadius: 1,
    markStroke: 2.5,
    midMarks: false,
  }),
  optionFields: Object.freeze([
    Object.freeze({ key: 'point', label: 'Box point', type: 'point' }),
    Object.freeze({ key: 'curve', label: 'Box growth', type: 'select', options: Object.freeze([
      Object.freeze({ value: 'reference', label: 'Reference' }),
      ...ZOOM_RULER_EASINGS,
    ]) }),
    // Only read by the Reference curve: where its breathing hold sits.
    Object.freeze({ key: 'holdSize', label: 'Hold size (reference)', type: 'range', min: 15, max: 75, step: 1, suffix: '%' }),
    Object.freeze({ key: 'startSize', label: 'Start size', type: 'range', min: 0, max: 300, step: 1, suffix: 'px' }),
    Object.freeze({ key: 'boxShape', label: 'Box shape', type: 'select', options: Object.freeze([
      Object.freeze({ value: 'frame', label: 'Match frame' }),
      Object.freeze({ value: 'reference', label: 'Reference (1.89 : 1)' }),
      Object.freeze({ value: 'square', label: 'Square' }),
      Object.freeze({ value: 'custom', label: 'Custom ratio' }),
    ]) }),
    Object.freeze({ key: 'boxRatio', label: 'Custom ratio (w : h)', type: 'range', min: 0.3, max: 3.5, step: 0.01 }),
    Object.freeze({ key: 'feather', label: 'Edge feather', type: 'range', min: 0, max: 60, step: 1, suffix: 'px' }),
    Object.freeze({ type: 'section', key: 'sec-zoom', label: 'Zoom' }),
    Object.freeze({ key: 'zoom', label: 'Zoom', type: 'range', min: 0, max: 40, step: 0.5, suffix: '%' }),
    Object.freeze({ key: 'zoomDirection', label: 'Direction', type: 'select', options: Object.freeze([
      Object.freeze({ value: 'in', label: 'Push in' }),
      Object.freeze({ value: 'settle', label: 'Settle' }),
    ]) }),
    Object.freeze({ key: 'zoomEasing', label: 'Zoom easing', type: 'select', options: Object.freeze([
      Object.freeze({ value: 'follow', label: 'Follow the box' }),
      ...ZOOM_RULER_EASINGS,
    ]) }),
    Object.freeze({ type: 'section', key: 'sec-rulers', label: 'Rulers' }),
    Object.freeze({ key: 'rulers', label: 'Rulers', type: 'switch' }),
    Object.freeze({ key: 'fadeIn', label: 'Fade in', type: 'range', min: 0, max: 40, step: 0.5, suffix: '%' }),
    Object.freeze({ key: 'spacingX', label: 'Spacing horizontal', type: 'range', min: -200, max: 400, step: 1, suffix: 'px' }),
    Object.freeze({ key: 'spacingY', label: 'Spacing vertical', type: 'range', min: -200, max: 400, step: 1, suffix: 'px' }),
    Object.freeze({ key: 'lineColor', label: 'Line colour', type: 'color' }),
    Object.freeze({ key: 'lineOpacity', label: 'Line opacity', type: 'range', min: 0, max: 100, step: 1, suffix: '%' }),
    Object.freeze({ key: 'lineWidth', label: 'Line width', type: 'range', min: 0.5, max: 12, step: 0.25, suffix: 'px' }),
    Object.freeze({ key: 'extend', label: 'Lines extend', type: 'select', options: Object.freeze([
      Object.freeze({ value: 'frame', label: 'Full frame' }),
      Object.freeze({ value: 'length', label: 'Past the corners' }),
      Object.freeze({ value: 'box', label: 'Box outline only' }),
    ]) }),
    Object.freeze({ key: 'extendLength', label: 'Extend length', type: 'range', min: 0, max: 1000, step: 1, suffix: 'px' }),
    Object.freeze({ key: 'dash', label: 'Dash', type: 'range', min: 0, max: 60, step: 1, suffix: 'px' }),
    Object.freeze({ type: 'section', key: 'sec-corners', label: 'Corners' }),
    Object.freeze({ key: 'markShape', label: 'Corner shape', type: 'select', options: Object.freeze([
      Object.freeze({ value: 'square', label: 'Square' }),
      Object.freeze({ value: 'circle', label: 'Circle' }),
      Object.freeze({ value: 'diamond', label: 'Diamond' }),
      Object.freeze({ value: 'squareOutline', label: 'Square outline' }),
      Object.freeze({ value: 'circleOutline', label: 'Circle outline' }),
      Object.freeze({ value: 'cross', label: 'Cross' }),
      Object.freeze({ value: 'bracket', label: 'Corner bracket' }),
      Object.freeze({ value: 'none', label: 'None' }),
    ]) }),
    Object.freeze({ key: 'markColor', label: 'Corner colour', type: 'color' }),
    Object.freeze({ key: 'markWidth', label: 'Corner width', type: 'range', min: 2, max: 120, step: 1, suffix: 'px' }),
    Object.freeze({ key: 'markHeight', label: 'Corner height', type: 'range', min: 2, max: 120, step: 1, suffix: 'px' }),
    Object.freeze({ key: 'markRadius', label: 'Corner radius', type: 'range', min: 0, max: 60, step: 0.5, suffix: 'px' }),
    Object.freeze({ key: 'markStroke', label: 'Corner stroke', type: 'range', min: 0.5, max: 16, step: 0.25, suffix: 'px' }),
    Object.freeze({ key: 'midMarks', label: 'Mid-edge marks', type: 'switch' }),
  ]),
  createInstance(context) {
    const { THREE } = context;
    const instance = makeTwoTextureInstance(context, 'zoomRuler', ZOOM_RULER_FRAGMENT, {
      uPrevious: { value: null },
      uCurrent: { value: null },
      uRes: { value: new THREE.Vector2(context.width, context.height) },
      uC: { value: new THREE.Vector2(context.width / 2, context.height / 2) },
      uMH: { value: new THREE.Vector2(0, 0) },
      uH: { value: new THREE.Vector2(0.5, 0.5) },
      uFeather: { value: 0 },
      uMaskIn: { value: 0 },
      uZoomB: { value: 1 },
      uAlpha: { value: 0 },
      uLineW: { value: 1.5 },
      uLineA: { value: 0.9 },
      uExt: { value: 1e6 },
      uDash: { value: 0 },
      uLineCol: { value: new THREE.Vector3(1, 1, 1) },
      uHS: { value: new THREE.Vector2(7.5, 7.5) },
      uHR: { value: 1 },
      uHShape: { value: 0 },
      uHStroke: { value: 2.5 },
      uMid: { value: 0 },
      uHCol: { value: new THREE.Vector3(1, 1, 1) },
    });
    // Both plates and this pass are premultiplied (see makeTwoTextureInstance).
    return {
      resize(size) { instance.resize(size); },
      render(frame) {
        if (!bindFrame(instance, frame)) return;
        const u = instance.material.uniforms;
        const o = frame.options || {};
        const s = zoomRulerFrame(o, frame.rawProgress, frame.width, frame.height);
        u.uRes.value.set(Math.max(1, frame.width), Math.max(1, frame.height));
        u.uC.value.set(s.cx, s.cy);
        u.uMH.value.set(s.hx, s.hy);
        u.uH.value.set(s.rx, s.ry);
        u.uFeather.value = s.feather;
        u.uMaskIn.value = s.fade;
        u.uZoomB.value = s.zoomB;
        u.uAlpha.value = s.rulers ? s.fade : 0;
        u.uLineW.value = s.lineW;
        u.uLineA.value = clamp01(finite(o.lineOpacity, 90) / 100);
        u.uExt.value = o.extend === 'length' ? Math.max(0, finite(o.extendLength, 90)) * s.k
          : (o.extend === 'box' ? 0 : 1e6);
        u.uDash.value = Math.max(0, finite(o.dash, 0)) * s.k;
        setHexVec(u.uLineCol.value, o.lineColor, 'ffffff');
        u.uHS.value.set(Math.max(0.25, s.markW / 2), Math.max(0.25, s.markH / 2));
        u.uHR.value = Math.max(0, finite(o.markRadius, 1)) * s.k;
        u.uHShape.value = s.shape;
        u.uHStroke.value = Math.max(0.25, finite(o.markStroke, 2.5) * s.k);
        u.uMid.value = o.midMarks ? 1 : 0;
        setHexVec(u.uHCol.value, o.markColor, 'ffffff');
      },
      dispose() { instance.dispose(); },
    };
  },
});

/*
 * Gradient Glow Stack — html/gradient-glow-stack-transition.html, ported verbatim.
 *
 * Decoded from the "Earn Edits Lovable" After Effects project (16–18 s): a stack
 * of huge Gaussian-blurred circles (blue → pink → red → salmon, the last on top)
 * sweeps through the frame in a stagger. Each layer flies from past the near edge
 * to past the far edge on its own staggered clock; B takes over behind the centre
 * line of the layer under the top one, where the stack is opaque, so the outgoing
 * clip never shows again once the stack has passed.
 *
 * Sizes are in units of S⊥, the frame's span ACROSS the travel (1080 for bottom →
 * top on 9:16). Along the travel a layer is squeezed by `aniso` (AE-style
 * non-uniform scale, blur included) so every aspect keeps the 9:16 reference's
 * proportions to the frame — unsqueezed, a 16:9 bottom → top layer was 4× the
 * frame height and most of each move happened while it still covered everything.
 * AE's Gaussian blurriness ≈ 3σ (fitted on the reference render).
 *
 * All layers share ONE ease: the reference's slower top-layer ease let red outrun
 * salmon and opened an 80 % dip in the glow between them.
 *
 * Fade out (option): the gradient SHAPES fade (flattened, so a half-faded top
 * layer never shows the colours under it) over the last `fadeLength` s, ending
 * with the transition. Played to its end the sweep has often left the frame by
 * then, so with the fade on the sweep is paced to cover the frame (top layer's
 * centre mid-frame) when the fade starts; B takes over everywhere in the last 4 %
 * of the sweep before it, hidden under the shapes — the clips never dissolve.
 * Cross-fade (option): the clips dissolve instead, for exactly as long as any
 * shape is in view.
 *
 * In / Out run the same pass one-sided: the empty lane is transparent, so the glow
 * sweeps over what is under the layer and the layer appears (or goes) behind it.
 *
 * Covers (option): the sweep is sized to, centred on and clipped to the LAYER's
 * screen box (the union of both clips' boxes on a cross; layerFitRect) — a text
 * or a scaled card gets the stack across itself, not across the whole frame.
 * "Layer shape" also keeps the glow to the plates' own pixels (their alpha);
 * "Whole frame" is the original full-composition sweep. A full-frame clip
 * reports the whole frame, so all three agree on ordinary video.
 *
 * The package eases its own clock from rawProgress (each layer has its own
 * staggered local clock), so the modal's EASE row is replaced by `easing`.
 */
const GLOW_STACK = Object.freeze({
  RTAB: Object.freeze([1.522, 1.344, 1.188, 1.188]),   // radius / S⊥, bottom → top of the stack
  STAB: Object.freeze([0.362, 0.320, 0.203, 0.140]),   // σ / S⊥
  MARGIN: 2.5,       // off-frame = edge + R + 2.5σ (alpha 0.6 %)
  COVER_SWAP: 0.04,  // fade out: B takes over in the last 4 % of the sweep before the fade
  MAX_LAYERS: 6,
});
const GLOW_STACK_COLORS = Object.freeze(['#4b73ff', '#ff66f4', '#ff0105', '#ff8282', '#ffc46b', '#8a5cff']);
const GLOW_STACK_DIRECTIONS = Object.freeze({
  up: [0, 1], down: [0, -1], right: [1, 0], left: [-1, 0],
  upRight: [Math.SQRT1_2, Math.SQRT1_2], upLeft: [-Math.SQRT1_2, Math.SQRT1_2],
  downRight: [Math.SQRT1_2, -Math.SQRT1_2], downLeft: [-Math.SQRT1_2, -Math.SQRT1_2],
});
const glowTab = (arr, f) => {
  const x = clamp01(f) * (arr.length - 1);
  const i = Math.min(arr.length - 2, Math.floor(x));
  return arr[i] + (arr[i + 1] - arr[i]) * (x - i);
};
// '#rgb', '#rrggbb', '#rrggbbaa' or rgb()/rgba() → [r, g, b] 0..1 (alpha ignored)
function glowRgb(value, fallback) {
  const raw = typeof value === 'string' ? value.trim() : '';
  let m = /^#?([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(raw);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255);
  m = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(raw);
  if (m) return [1, 2, 3].map((i) => parseInt(m[i] + m[i], 16) / 255);
  m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(raw);
  if (m) return [1, 2, 3].map((i) => clamp01(Number(m[i]) / 255));
  return fallback === undefined ? [1, 1, 1] : glowRgb(fallback);
}
function glowStaggerParams(n, staggerPct) {
  let stg = Math.max(0, staggerPct) / 100;
  if (n > 1 && 1 - (n - 1) * stg < 0.1) stg = 0.9 / (n - 1);
  return { stg, win: 1 - (n - 1) * stg };
}
function glowStaggerLocal(phase, rank, n, staggerPct) {
  const { stg, win } = glowStaggerParams(n, staggerPct);
  return clamp01((phase - rank * stg) / win);
}
// sweep progress at which the TOP layer's centre crosses mid-frame
function glowCoverMoment(n, staggerPct, ease) {
  const { stg, win } = glowStaggerParams(n, staggerPct);
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i += 1) { const m = (lo + hi) / 2; if (ease(m) < 0.5) lo = m; else hi = m; }
  return (n - 1) * stg + win * (lo + hi) / 2;
}
function glowStackGeometry(o, W, H, duration) {
  const ang = (finite(o.angle, 90) * Math.PI) / 180;
  const dir = o.direction === 'angle' ? [Math.cos(ang), Math.sin(ang)] : (GLOW_STACK_DIRECTIONS[o.direction] || GLOW_STACK_DIRECTIONS.up);
  const perp = [-dir[1], dir[0]];
  const T = Math.abs(W * dir[0]) + Math.abs(H * dir[1]);
  const S = Math.abs(W * perp[0]) + Math.abs(H * perp[1]);
  const aniso = S / Math.max(1e-6, Math.min(S, (T * 1080) / 1920));
  const n = Math.max(2, Math.min(GLOW_STACK.MAX_LAYERS, Math.round(finite(o.layers, 4))));
  const ease = pixelBlocksEase(o.easing || TransitionEasing.NATURAL);
  const size = Math.max(0.05, finite(o.size, 100) / 100);
  const softness = Math.max(0, finite(o.softness, 100) / 100);
  const base = [];
  for (let i = 0; i < n; i += 1) {
    const f = i / (n - 1);
    const R = glowTab(GLOW_STACK.RTAB, f) * S * size;
    const sigma = Math.max(0.5, glowTab(GLOW_STACK.STAB, f) * S * softness);
    base.push({ R, sigma, off: T / 2 + (R + GLOW_STACK.MARGIN * sigma) / aniso, color: glowRgb(o[`color${i + 1}`], GLOW_STACK_COLORS[i]) });
  }
  const fadeOut = !!o.fadeOut;
  // the fade window, as a fraction of the transition — at least 15 % stays sweep
  const fadeFrom = fadeOut ? Math.max(0.15, 1 - Math.max(0, finite(o.fadeLength, 0.6)) / Math.max(finite(duration, 1), 1e-3)) : 1;
  const mc = fadeOut ? glowCoverMoment(n, finite(o.stagger, 2.5), ease) : 1;
  return {
    dir, perp, T, S, aniso, n, ease, base, fadeOut, fadeFrom, mc,
    stagger: finite(o.stagger, 2.5),
    round: o.shape === 'square' ? clamp01(finite(o.roundness, 30) / 100) : 1,
  };
}
function glowStackAt(G, p) {
  const fade = G.fadeOut && p > G.fadeFrom ? clamp01((p - G.fadeFrom) / (1 - G.fadeFrom)) : 0;
  const m = G.fadeOut ? Math.min(1, (p * G.mc) / G.fadeFrom) : p;   // sweep clock
  const s = G.base.map((b, i) => -b.off + 2 * b.off * G.ease(glowStaggerLocal(m, i, G.n, G.stagger)));
  return { s, fade, stackAlpha: 1 - pixelBlocksEase(TransitionEasing.SINE_IN_OUT)(fade) };
}
// [first, last] progress with any shape in view (≥ 1 % glow inside the frame, not faded out)
function glowVisibleWindow(G) {
  const visible = (p) => {
    const at = glowStackAt(G, p);
    if (at.stackAlpha < 0.01) return false;
    return G.base.some((b, i) => Math.abs(at.s[i]) - (b.R + 2.33 * b.sigma) / G.aniso < G.T / 2);
  };
  const N = 400;
  let first = -1;
  let last = -1;
  for (let k = 0; k <= N; k += 1) if (visible(k / N)) { if (first < 0) first = k; last = k; }
  if (first < 0) return [0, 1];
  let lo = Math.max(0, first - 1) / N;
  let hi = first / N;
  for (let i = 0; i < 20 && first > 0; i += 1) { const q = (lo + hi) / 2; if (visible(q)) hi = q; else lo = q; }
  const p0 = first > 0 ? hi : 0;
  lo = last / N;
  hi = Math.min(N, last + 1) / N;
  for (let i = 0; i < 20 && last < N; i += 1) { const q = (lo + hi) / 2; if (visible(q)) lo = q; else hi = q; }
  return [p0, last < N ? hi : 1];
}

/**
 * One frame of the stack — shared by the pass and the picker tile. Pixels are
 * frame-centred with y UP; `s` runs along the travel, `t` across it.
 */
export function glowStackFrame(options, rawProgress, W, H, duration) {
  const o = options || {};
  const G = glowStackGeometry(o, Math.max(1, W), Math.max(1, H), duration);
  const p = clamp01(finite(rawProgress, 0));
  const at = glowStackAt(G, p);
  const layers = G.base.map((b, i) => ({ s: at.s[i], R: b.R, sigma: b.sigma, color: b.color }));
  const sw = layers[Math.max(0, G.n - 2)];
  const swapFrom = G.fadeFrom * Math.max(0, 1 - GLOW_STACK.COVER_SWAP / G.mc);
  const coverSwap = G.fadeOut ? smoothstepJs(swapFrom, G.fadeFrom, p) : 0;
  const cfAt = o.crossfade ? glowVisibleWindow(G) : null;
  const cf = cfAt ? pixelBlocksEase(TransitionEasing.SINE_IN_OUT)(clamp01((p - cfAt[0]) / Math.max(cfAt[1] - cfAt[0], 1e-4))) : 0;
  return {
    dir: G.dir, perp: G.perp, T: G.T, S: G.S, aniso: G.aniso, n: G.n, round: G.round, layers,
    swapLine: o.crossfade ? -1e6 : sw.s,
    swapSoft: Math.max(1, (sw.sigma * 0.5) / G.aniso),
    swapAll: o.crossfade ? cf : coverSwap,
    crossfadeAt: cfAt,
    stackAlpha: at.stackAlpha,
  };
}
function smoothstepJs(a, b, x) {
  const t = clamp01((x - a) / Math.max(1e-6, b - a));
  return t * t * (3 - 2 * t);
}

const GLOW_STACK_FRAGMENT = /* glsl */ `
uniform sampler2D uPrevious;
uniform sampler2D uCurrent;
uniform vec2  uRes;        // composition size, px
uniform vec2  uCenter;     // the sweep's centre, px (frame or layer box)
uniform vec4  uBox;        // glow clip rect, px: x0, y0, x1, y1
uniform float uShapeMask;  // 1 = glow only on the plates' own pixels
uniform vec2  uDir;        // travel direction, y up
uniform float uN;          // layers in use (2..6)
uniform vec4  uL0; uniform vec4 uL1; uniform vec4 uL2; uniform vec4 uL3; uniform vec4 uL4; uniform vec4 uL5;
uniform vec3  uC0; uniform vec3 uC1; uniform vec3 uC2; uniform vec3 uC3; uniform vec3 uC4; uniform vec3 uC5;
uniform float uRound;      // corner radius / R (1 = circle)
uniform float uAniso;      // along-travel squeeze
uniform float uSwapLine;   // B behind this line (px along the travel)
uniform float uSwapSoft;
uniform float uSwapAll;    // B everywhere (fade take-over / cross-fade)
uniform float uStackAlpha; // the shapes' opacity, flattened (fade out)
uniform float uBlend;      // 0 normal, 1 screen, 2 add
uniform float uGrain;
uniform float uGrainSize;
uniform float uSeed;
varying vec2 vUv;

float Phi(float z) { z = clamp(z, -8.0, 8.0); return 1.0 / (1.0 + exp(-1.5976 * z - 0.07056 * z * z * z)); }
float sdShape(vec2 q, float R) {
  float rc = uRound * R;
  vec2 d = abs(q) - vec2(R - rc);
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - rc;
}
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
// premultiplied: the glow layer over what is under it
void glowLayer(inout vec4 col, inout float cover, vec4 L, vec3 C, float s, float t, float on) {
  float a = Phi(-sdShape(vec2((s - L.x) * uAniso, t), L.y) / L.z) * L.w * on;
  vec3 src = C * a;
  float alpha = a + col.a - a * col.a;
  if (uBlend < 0.5) col = vec4(src + col.rgb * (1.0 - a), alpha);
  else if (uBlend < 1.5) col = vec4(src + col.rgb - src * col.rgb, alpha);
  else col = vec4(min(col.rgb + src, vec3(alpha)), alpha);
  cover = cover + a - cover * a;
}
void main() {
  vec2 px = vUv * uRes;
  vec2 p = px - uCenter;
  float s = dot(p, uDir);
  float t = dot(p, vec2(-uDir.y, uDir.x));
  vec4 A = texture2D(uPrevious, vUv);
  vec4 B = texture2D(uCurrent, vUv);
  float wB = max(Phi((uSwapLine - s) / uSwapSoft), uSwapAll);
  vec4 base = mix(A, B, wB);
  vec4 col = base;
  float cover = 0.0;
  // Covers: inside the box (1 px soft edge), and on the plates' pixels for Layer shape
  vec2 inBox = min(px - uBox.xy, uBox.zw - px);
  float m = clamp(min(inBox.x, inBox.y) + 0.5, 0.0, 1.0) * mix(1.0, max(A.a, B.a), uShapeMask);
  glowLayer(col, cover, uL0, uC0, s, t, m);
  glowLayer(col, cover, uL1, uC1, s, t, m);
  glowLayer(col, cover, uL2, uC2, s, t, step(2.5, uN) * m);
  glowLayer(col, cover, uL3, uC3, s, t, step(3.5, uN) * m);
  glowLayer(col, cover, uL4, uC4, s, t, step(4.5, uN) * m);
  glowLayer(col, cover, uL5, uC5, s, t, step(5.5, uN) * m);
  col = mix(base, col, uStackAlpha);
  cover *= uStackAlpha;
  float g = hash12(floor(px / uGrainSize) + vec2(uSeed * 17.0, uSeed * 31.0)) - 0.5;
  col.rgb = clamp(col.rgb + g * 2.0 * uGrain * cover, vec3(0.0), vec3(col.a));
  gl_FragColor = col;
}
`;

const GLOW_STACK_SHAPES = Object.freeze([
  Object.freeze({ value: 'circle', label: 'Circle' }),
  Object.freeze({ value: 'square', label: 'Square' }),
]);

export const GLOW_STACK_PRESET = Object.freeze({
  type: 'Gradient Glow Stack',
  name: 'Gradient Glow Stack',
  category: 'advanced',
  description: 'A stack of huge soft gradient glows sweeps through the frame; the next clip appears behind it',
  defaultDuration: 2.27,
  optionDefaults: Object.freeze({
    covers: 'box',
    direction: 'up',
    angle: 90,
    easing: TransitionEasing.NATURAL,
    stagger: 2.5,
    fadeOut: false,
    fadeLength: 0.6,
    crossfade: false,
    shape: 'circle',
    roundness: 30,
    size: 100,
    softness: 100,
    layers: 4,
    color1: GLOW_STACK_COLORS[0],
    color2: GLOW_STACK_COLORS[1],
    color3: GLOW_STACK_COLORS[2],
    color4: GLOW_STACK_COLORS[3],
    color5: GLOW_STACK_COLORS[4],
    color6: GLOW_STACK_COLORS[5],
    blend: 'normal',
    grain: 5,
    grainSize: 1,
  }),
  optionFields: Object.freeze([
    Object.freeze({ key: 'covers', label: 'Covers', type: 'select', options: Object.freeze([
      Object.freeze({ value: 'box', label: 'Layer box' }),
      Object.freeze({ value: 'shape', label: 'Layer shape' }),
      Object.freeze({ value: 'frame', label: 'Whole frame' }),
    ]) }),
    Object.freeze({ key: 'direction', label: 'Direction', type: 'select', options: Object.freeze([
      Object.freeze({ value: 'up', label: 'Bottom → Top' }),
      Object.freeze({ value: 'down', label: 'Top → Bottom' }),
      Object.freeze({ value: 'right', label: 'Left → Right' }),
      Object.freeze({ value: 'left', label: 'Right → Left' }),
      Object.freeze({ value: 'upRight', label: 'Diagonal ↗' }),
      Object.freeze({ value: 'upLeft', label: 'Diagonal ↖' }),
      Object.freeze({ value: 'downRight', label: 'Diagonal ↘' }),
      Object.freeze({ value: 'downLeft', label: 'Diagonal ↙' }),
      Object.freeze({ value: 'angle', label: 'Custom angle' }),
    ]) }),
    Object.freeze({ key: 'angle', label: 'Angle', type: 'range', min: 0, max: 360, step: 1, suffix: '°' }),
    Object.freeze({ key: 'easing', label: 'Easing', type: 'select', options: PIXEL_BLOCKS_EASINGS }),
    Object.freeze({ key: 'stagger', label: 'Stagger', type: 'range', min: 0, max: 30, step: 0.1, suffix: '%' }),
    Object.freeze({ type: 'section', key: 'sec-ending', label: 'Fade' }),
    Object.freeze({ key: 'fadeOut', label: 'Fade out the shapes at the end', type: 'switch' }),
    Object.freeze({ key: 'fadeLength', label: 'Fade length', type: 'range', min: 0.1, max: 3, step: 0.05, suffix: ' s' }),
    Object.freeze({ key: 'crossfade', label: 'Cross-fade clips while the shapes move', type: 'switch' }),
    Object.freeze({ type: 'section', key: 'sec-shape', label: 'Shape' }),
    Object.freeze({ key: 'shape', label: 'Shape', type: 'select', options: GLOW_STACK_SHAPES }),
    Object.freeze({ key: 'roundness', label: 'Corner roundness (square)', type: 'range', min: 0, max: 100, step: 1, suffix: '%' }),
    Object.freeze({ key: 'size', label: 'Size', type: 'range', min: 40, max: 200, step: 1, suffix: '%' }),
    Object.freeze({ key: 'softness', label: 'Softness', type: 'range', min: 0, max: 250, step: 1, suffix: '%' }),
    Object.freeze({ type: 'section', key: 'sec-colours', label: 'Colours' }),
    Object.freeze({ key: 'layers', label: 'Layers', type: 'range', min: 2, max: 6, step: 1 }),
    Object.freeze({ key: 'color1', label: 'Colour 1 (bottom, leads)', type: 'color' }),
    Object.freeze({ key: 'color2', label: 'Colour 2', type: 'color' }),
    Object.freeze({ key: 'color3', label: 'Colour 3', type: 'color' }),
    Object.freeze({ key: 'color4', label: 'Colour 4', type: 'color' }),
    Object.freeze({ key: 'color5', label: 'Colour 5', type: 'color' }),
    Object.freeze({ key: 'color6', label: 'Colour 6', type: 'color' }),
    Object.freeze({ type: 'section', key: 'sec-look', label: 'Look' }),
    Object.freeze({ key: 'blend', label: 'Blend', type: 'select', options: Object.freeze([
      Object.freeze({ value: 'normal', label: 'Normal' }),
      Object.freeze({ value: 'screen', label: 'Screen' }),
      Object.freeze({ value: 'add', label: 'Add (glow)' }),
    ]) }),
    Object.freeze({ key: 'grain', label: 'Grain', type: 'range', min: 0, max: 30, step: 0.5, suffix: '%' }),
    Object.freeze({ key: 'grainSize', label: 'Grain size', type: 'range', min: 1, max: 6, step: 0.5, suffix: ' px' }),
  ]),
  createInstance(context) {
    const { THREE } = context;
    const v4 = () => ({ value: new THREE.Vector4(0, 1, 1, 0) });
    const v3 = () => ({ value: new THREE.Vector3(1, 1, 1) });
    const instance = makeTwoTextureInstance(context, 'glowStack', GLOW_STACK_FRAGMENT, {
      uPrevious: { value: null },
      uCurrent: { value: null },
      uRes: { value: new THREE.Vector2(context.width, context.height) },
      uCenter: { value: new THREE.Vector2(context.width / 2, context.height / 2) },
      uBox: { value: new THREE.Vector4(-1e6, -1e6, 1e6, 1e6) },
      uShapeMask: { value: 0 },
      uDir: { value: new THREE.Vector2(0, 1) },
      uN: { value: 4 },
      uL0: v4(), uL1: v4(), uL2: v4(), uL3: v4(), uL4: v4(), uL5: v4(),
      uC0: v3(), uC1: v3(), uC2: v3(), uC3: v3(), uC4: v3(), uC5: v3(),
      uRound: { value: 1 },
      uAniso: { value: 1 },
      uSwapLine: { value: -1e6 },
      uSwapSoft: { value: 1 },
      uSwapAll: { value: 0 },
      uStackAlpha: { value: 1 },
      uBlend: { value: 0 },
      uGrain: { value: 0.05 },
      uGrainSize: { value: 1 },
      uSeed: { value: 0 },
    });
    // Both plates and this pass are premultiplied (see makeTwoTextureInstance).
    return {
      resize(size) { instance.resize(size); },
      render(frame) {
        if (!bindFrame(instance, frame)) return;
        const u = instance.material.uniforms;
        const o = frame.options || {};
        const W = Math.max(1, frame.width);
        const H = Math.max(1, frame.height);
        // Covers: the sweep runs across the layer's box as the selection gizmo shows
        // it (contentBounds: a text's laid-out block, not its frame-sized plate),
        // NDC → px, y up like vUv; an unmeasurable box falls back to the frame.
        const covers = o.covers === 'frame' || o.covers === 'shape' ? o.covers : 'box';
        const rect = layerFitRect(covers === 'frame' ? 'frame' : 'layer', frame, 1, 'contentBounds');
        const bw = Math.max(1, rect.hx * W);
        const bh = Math.max(1, rect.hy * H);
        const cx = ((rect.cx + 1) / 2) * W;
        const cy = ((rect.cy + 1) / 2) * H;
        const F = glowStackFrame(o, frame.rawProgress, bw, bh, frame.duration);
        u.uRes.value.set(W, H);
        u.uCenter.value.set(cx, cy);
        if (rect.layerFit) u.uBox.value.set(cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2);
        else u.uBox.value.set(-1e6, -1e6, 1e6, 1e6);
        u.uShapeMask.value = covers === 'shape' ? 1 : 0;
        u.uDir.value.set(F.dir[0], F.dir[1]);
        u.uN.value = F.n;
        for (let i = 0; i < GLOW_STACK.MAX_LAYERS; i += 1) {
          const L = F.layers[i];
          // an unused slot sits far off-frame with alpha 0 (uN gates it as well)
          if (L) {
            u[`uL${i}`].value.set(L.s, L.R, L.sigma, 1);
            u[`uC${i}`].value.set(L.color[0], L.color[1], L.color[2]);
          } else u[`uL${i}`].value.set(-1e6, 1, 1, 0);
        }
        u.uRound.value = F.round;
        u.uAniso.value = F.aniso;
        u.uSwapLine.value = F.swapLine;
        u.uSwapSoft.value = F.swapSoft;
        u.uSwapAll.value = F.swapAll;
        u.uStackAlpha.value = F.stackAlpha;
        u.uBlend.value = o.blend === 'screen' ? 1 : (o.blend === 'add' ? 2 : 0);
        u.uGrain.value = Math.max(0, finite(o.grain, 5)) / 100;
        // grain is authored in 1080p pixels, so preview and export share one grain size
        u.uGrainSize.value = Math.max(1, finite(o.grainSize, 1) * (Math.min(W, H) / 1080));
        u.uSeed.value = Math.floor(finite(frame.timeSec, 0) * 30) % 997;   // deterministic per frame
      },
      dispose() { instance.dispose(); },
    };
  },
});

/*
 * Gradient Map — decoded from "SaaS Gradent Transitions.aep" (py-aep) and its
 * aerender output over a grey ramp, no lab.
 *
 * Every one of the nine AE comps is the same recipe on one clip: a copy of it
 * runs Colorama (luminance → a looping palette, Phase Shift spinning) and a
 * Gradient Wipe keyed on its OWN luminance, over the plain clip settling from a
 * 120–150 % zoom. The wipe drops the map's darkest pixels first, so the real
 * picture arrives through the shadows and the highlights hold the colour longest.
 * Measured on the ramp, AE's wipe is exactly
 *     visible = clamp((L − c·(1 + s) + s) / s, 0, 1)
 * (c = Transition Completion, s = Transition Softness). The phase spins forward:
 * output = palette(fract(L · repetitions + phase)).
 *
 * The AE comps are entrances. A cross adds the mirror image in front of the cut:
 * the map builds over A (the reveal played backwards), the map of B wipes in over
 * the map of A brightest-first (comp 02's first stage) and B's map wipes off as
 * in AE. An entrance skips the first stage (B's map arrives over what is under
 * the layer), an exit skips the last (A's map leaves to nothing, darkest first).
 *
 * Palettes are the comps' own Output Cycles, fitted to ≤ 8 linear stops from
 * frame 0 of a compressed ramp (≤ 2/255 on the clean ones). AE's Color Control
 * (Color Balance HLS after Colorama) is applied to the stops here, not per pixel.
 * The accents are the cheap overlays of comps 03 / 04 / 08 (dot ring, plus grid,
 * pixel ring); the blur rings (05 / 06) and the dust plate (07) are not ported.
 *
 * The package eases its own stage clocks from rawProgress, so the modal's EASE
 * row is replaced by `easing`; the zoom keeps AE's own curve.
 */
const GRADIENT_MAP_PALETTES = Object.freeze({
  rose: [[0, '#e8a4a6'], [0.164, '#d98396'], [0.336, '#ed7b95'], [0.504, '#dcf7f2'], [0.668, '#e3a4b5'], [0.832, '#f0d9df']],
  amber: [[0, '#541a07'], [0.145, '#9c4d12'], [0.289, '#fdb653'], [0.34, '#fabf67'], [0.438, '#f2cc8d'], [0.586, '#905d24'], [0.688, '#c08330'], [0.852, '#febb58']],
  fireIce: [[0, '#28050c'], [0.172, '#971620'], [0.367, '#cd3232'], [0.508, '#f0eae9'], [0.66, '#93c4e9'], [0.766, '#589cd0'], [0.855, '#2877b5']],
  pastel: [[0, '#fefdfa'], [0.184, '#f9d580'], [0.324, '#eca364'], [0.371, '#e89763'], [0.414, '#e7a07f'], [0.504, '#e5b9c0'], [0.648, '#d7cdde'], [0.828, '#dce0e7']],
  cream: [[0, '#e6dcac'], [0.18, '#b8dae3'], [0.367, '#e3d2a3'], [0.5, '#ebe3bf'], [0.668, '#f7f5c8'], [0.852, '#f6efc9']],
  peach: [[0, '#d8b297'], [0.105, '#d7b1bf'], [0.281, '#e0b383'], [0.324, '#e1b271'], [0.504, '#d6d8da'], [0.676, '#d5cea4'], [0.895, '#e79658']],
  lime: [[0, '#f4db8e'], [0.09, '#e3feb2'], [0.254, '#b0bf97'], [0.543, '#f7fd8a'], [0.867, '#e0fead']],
  ultraviolet: [[0, '#5b16b8'], [0.086, '#8736e5'], [0.25, '#d687d8'], [0.52, '#f29985'], [0.789, '#f5d499'], [0.949, '#8449af']],
  // Colorama's own default Output Cycle — with "Highlights first" it reads as comp 02
  rainbow: [[0, '#ff0000'], [1 / 6, '#ffff00'], [2 / 6, '#00ff00'], [3 / 6, '#00ffff'], [4 / 6, '#0000ff'], [5 / 6, '#ff00ff']],
});
const GRADIENT_MAP_PALETTE_OPTIONS = Object.freeze([
  Object.freeze({ value: 'rose', label: 'Rose' }),
  Object.freeze({ value: 'amber', label: 'Amber' }),
  Object.freeze({ value: 'fireIce', label: 'Fire & Ice' }),
  Object.freeze({ value: 'pastel', label: 'Pastel Sunset' }),
  Object.freeze({ value: 'cream', label: 'Cream' }),
  Object.freeze({ value: 'peach', label: 'Peach' }),
  Object.freeze({ value: 'lime', label: 'Lime' }),
  Object.freeze({ value: 'ultraviolet', label: 'Ultraviolet' }),
  Object.freeze({ value: 'rainbow', label: 'Rainbow' }),
  Object.freeze({ value: 'custom', label: 'Custom (4 colours)' }),
]);
const GRADIENT_MAP_CUSTOM = Object.freeze(['#ff4fa3', '#ffd36b', '#5ee0ff', '#7b5cff']);
const GRADIENT_MAP_ACCENTS = Object.freeze({ none: 0, dots: 1, plus: 2, pixels: 3 });
const GRADIENT_MAP_MAX_STOPS = 8;
// AE's zoom key on the base layer (out 12.44 %, in 94.08 %, both speeds 0)
const gradientMapZoomEase = cubicBezierEase(0.1244, 0, 0.0592, 1);

function gmRgbToHsl([r, g, b]) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max - min < 1e-6) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}
function gmHslToRgb([h, s, l]) {
  if (s < 1e-6) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const ch = (t) => {
    const x = t - Math.floor(t);
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return [ch(h + 1 / 3), ch(h), ch(h - 1 / 3)];
}
// AE Color Balance (HLS): hue in degrees, lightness / saturation −100..100
function gmColorControl(rgb, hue, light, sat) {
  if (!hue && !light && !sat) return rgb;
  let [h, s, l] = gmRgbToHsl(rgb);
  h += hue / 360;
  l = light >= 0 ? l + (1 - l) * (light / 100) : l * (1 + light / 100);
  s = sat >= 0 ? s + (1 - s) * (sat / 100) : s * (1 + sat / 100);
  return gmHslToRgb([h, clamp01(s), clamp01(l)]);
}

/** The palette as [r, g, b, cyclePosition] stops, colour control applied. */
export function gradientMapStops(options) {
  const o = options || {};
  const raw = o.palette === 'custom'
    ? [0, 1, 2, 3].map((i) => [i / 4, o[`color${i + 1}`] || GRADIENT_MAP_CUSTOM[i]])
    : (GRADIENT_MAP_PALETTES[o.palette] || GRADIENT_MAP_PALETTES.rose);
  const hue = finite(o.hue, 0);
  const light = Math.max(-100, Math.min(100, finite(o.lightness, 0)));
  const sat = Math.max(-100, Math.min(100, finite(o.saturation, 0)));
  return raw.slice(0, GRADIENT_MAP_MAX_STOPS).map(([pos, hex], i) => {
    const fallback = o.palette === 'custom' ? GRADIENT_MAP_CUSTOM[i] : '#ffffff';
    return [...gmColorControl(glowRgb(hex, fallback), hue, light, sat), pos];
  });
}
/** Looping palette lookup, x in [0, 1) — the shader's gmPalette. */
export function gradientMapPaletteAt(stops, x) {
  for (let i = 0; i < stops.length; i += 1) {
    const a = stops[i];
    const b = i + 1 < stops.length ? stops[i + 1] : [stops[0][0], stops[0][1], stops[0][2], 1];
    if (x >= a[3] && x < b[3]) {
      const t = (x - a[3]) / Math.max(b[3] - a[3], 1e-5);
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    }
  }
  return stops[0].slice(0, 3);
}

/**
 * The optional reveal point in frame pixels, y UP (stored as % of the frame with y
 * down, like Circular Wipe's), its distance to the farthest corner — so the
 * order still runs 0 → 1 over the whole frame wherever the point sits, even off
 * it — and how much it weighs against the brightness order (0 = off).
 */
export function gradientMapPoint(options, W, H) {
  const o = options || {};
  const x = (finite(o.point?.x, 50) / 100) * W;
  const y = (1 - finite(o.point?.y, 50) / 100) * H;
  const maxD = Math.max(1, Math.hypot(Math.max(Math.abs(x), Math.abs(W - x)), Math.max(Math.abs(y), Math.abs(H - y))));
  const amt = o.pointReveal ? clamp01(finite(o.pointStrength, 75) / 100) : 0;
  return { x, y, maxD, amt };
}

/**
 * One frame's clocks — shared by the pass and the picker tile. `slot` is the
 * runtime's 'cross' / 'in' / 'out': an entrance has no A stage, an exit no reveal.
 */
export function gradientMapFrame(options, rawProgress, slot = 'cross', duration = 2.5) {
  const o = options || {};
  const p = clamp01(finite(rawProgress, 0));
  const ease = pixelBlocksEase(o.easing || TransitionEasing.LINEAR);
  let s1 = slot === 'in' ? 0 : Math.max(0, finite(o.mapIn, 30));
  let s2 = Math.max(0, finite(o.swap, 10));
  let s3 = slot === 'out' ? 0 : Math.max(0, finite(o.reveal, 60));
  const sum = s1 + s2 + s3;
  if (sum < 1e-4) { s2 = 1; s1 = 0; s3 = 0; } else { s1 /= sum; s2 /= sum; s3 /= sum; }
  const mapA = s1 > 1e-4 ? ease(clamp01(p / s1)) : 1;
  const swap = s2 > 1e-4 ? ease(clamp01((p - s1) / s2)) : (p >= s1 ? 1 : 0);
  const reveal = s3 > 1e-4 ? ease(clamp01((p - s1 - s2) / s3)) : 0;
  const Z = Math.max(1, finite(o.zoom, 120) / 100);
  // A pushes in to the zoom by the end of the swap (AE's curve, mirrored in time),
  // B settles from it over the swap and 80 % of the reveal, as the AE base layer does
  const qA = clamp01(p / Math.max(s1 + s2, 1e-4));
  const qB = clamp01((p - s1) / Math.max(s2 + 0.8 * s3, 1e-4));
  const zoomA = 1 + (Z - 1) * (1 - gradientMapZoomEase(1 - qA));
  const zoomB = Z - (Z - 1) * gradientMapZoomEase(qB);
  const timeSec = p * Math.max(0, finite(duration, 2.5));
  const spin = finite(o.spin, 450) / 360;
  const phase = ((spin * timeSec) % 1 + 1) % 1;
  const b0 = Math.max(0.1, finite(o.bandsStart, 1));
  const b1 = Math.max(0.1, finite(o.bandsEnd, 1));
  const bands = b0 + (b1 - b0) * ease(p);
  // the accent ring rides from just before the swap's middle to 90 % of the reveal
  const a0 = Math.max(0, s1 + 0.5 * s2 - 0.05);
  const a1 = s3 > 1e-4 ? s1 + s2 + 0.9 * s3 : 1;
  const qa = clamp01((p - a0) / Math.max(a1 - a0, 1e-4));
  const accentEnv = smoothstepJs(0, 0.15, qa) * (1 - smoothstepJs(0.6, 1, qa));
  return {
    slot, mapA, swap, reveal, zoomA, zoomB, phase, bands, timeSec,
    soft: Math.max(0.001, clamp01(finite(o.softness, 50) / 100)),
    order: o.order === 'highlights' ? 1 : 0,
    accent: GRADIENT_MAP_ACCENTS[o.accent] || 0,
    accentRing: gradientMapZoomEase(qa),   // × 1.15 half-diagonals
    accentAmt: accentEnv * Math.max(0, finite(o.accentStrength, 100)) / 100,
    stops: gradientMapStops(o),
  };
}

const GRADIENT_MAP_FRAGMENT = /* glsl */ `
uniform sampler2D uPrevious;
uniform sampler2D uCurrent;
uniform vec2  uRes;
// palette stops: rgb + cycle position; the slot after the last holds the wrap
// (first colour at 1.0) and every unused slot sits at 2.0, past any lookup
uniform vec4  uP0; uniform vec4 uP1; uniform vec4 uP2; uniform vec4 uP3; uniform vec4 uP4;
uniform vec4  uP5; uniform vec4 uP6; uniform vec4 uP7; uniform vec4 uP8;
uniform float uPhase;
uniform float uBands;
uniform float uSoft;
uniform float uOrder;      // 0 = shadows first, 1 = highlights first
uniform float uMapA;       // A → map of A
uniform float uSwap;       // map of A → map of B
uniform float uReveal;     // map of B → B
uniform float uZoomA;
uniform float uZoomB;
uniform float uExit;       // 1 = Out slot: the map leaves to nothing
uniform float uAccent;     // 0 none, 1 dot ring, 2 plus grid, 3 pixel ring
uniform vec3  uAccentCol;
uniform float uAccentAmt;  // strength × envelope
uniform float uRingR;      // px
uniform float uRingW;      // px
uniform float uPitch;      // px
uniform float uTime;
uniform vec2  uPoint;      // reveal point, px, y up
uniform float uPointMaxD;  // its distance to the farthest corner, px
uniform float uPointAmt;   // 0 = brightness order only, 1 = soft circles growing out of the point
varying vec2 vUv;

float gmLuma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
vec3 gmSeg(vec3 c, vec4 a, vec4 b, float x) {
  float t = (x - a.w) / max(b.w - a.w, 1e-5);
  return (x >= a.w && x < b.w) ? mix(a.rgb, b.rgb, t) : c;
}
vec3 gmPalette(float x) {
  vec3 c = uP0.rgb;
  c = gmSeg(c, uP0, uP1, x); c = gmSeg(c, uP1, uP2, x); c = gmSeg(c, uP2, uP3, x);
  c = gmSeg(c, uP3, uP4, x); c = gmSeg(c, uP4, uP5, x); c = gmSeg(c, uP5, uP6, x);
  c = gmSeg(c, uP6, uP7, x); c = gmSeg(c, uP7, uP8, x);
  return c;
}
// AE Gradient Wipe: how much of the layer is left at completion c
float gmWipe(float key, float c) {
  return clamp((key - c * (1.0 + uSoft) + uSoft) / uSoft, 0.0, 1.0);
}
float gmHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
void main() {
  vec4 A = texture2D(uPrevious, 0.5 + (vUv - 0.5) / uZoomA);
  vec4 B = texture2D(uCurrent, 0.5 + (vUv - 0.5) / uZoomB);
  float lA = gmLuma(A.rgb / max(A.a, 1e-4));
  float lB = gmLuma(B.rgb / max(B.a, 1e-4));
  // the order the pixels go in: brightness, pulled toward the point. Like Circular Wipe
  // every front travels OUT from the point: the map arrives nearest first and the real
  // picture comes back nearest first — a high key gets the map first, a low key loses it first
  float dn = clamp(length(vUv * uRes - uPoint) / uPointMaxD, 0.0, 1.0);
  float baseA = mix(lA, 1.0 - lA, uOrder);
  float kA = mix(baseA, 1.0 - dn, uPointAmt);           // A's map builds
  float kAout = mix(baseA, dn, uPointAmt);              // A's map leaves (exit)
  float kB = mix(mix(lB, 1.0 - lB, uOrder), dn, uPointAmt);
  vec3 mA = gmPalette(fract(lA * uBands + uPhase)) * A.a;
  vec3 mB = gmPalette(fract(lB * uBands + uPhase)) * B.a;
  // premultiplied: the map builds over A (the reveal played backwards) and leaves B
  vec4 a = vec4(mix(A.rgb, mA, gmWipe(kA, 1.0 - uMapA)), A.a);
  vec4 b = vec4(mix(B.rgb, mB, gmWipe(kB, uReveal)), B.a);
  vec4 col;
  if (uExit > 0.5) col = a * gmWipe(kAout, uSwap);
  else {
    float w = gmWipe(mix(lB, 1.0 - dn, uPointAmt), 1.0 - uSwap);   // B's map arrives brightest (or nearest) first
    col = b * w + a * (1.0 - w);
  }
  if (uAccent > 0.5 && uAccentAmt > 0.001) {
    vec2 px = vUv * uRes;
    float r = length(px - 0.5 * uRes);
    float d = (r - uRingR) / uRingW;
    float ring = exp(-d * d);
    vec2 cell = fract(px / uPitch) * uPitch - 0.5 * uPitch;
    float m;
    if (uAccent < 1.5) {
      m = ring * (1.0 - smoothstep(0.14 * uPitch - 0.75, 0.14 * uPitch + 0.75, length(cell)));
    } else if (uAccent < 2.5) {
      vec2 q = abs(cell);
      float arm = 0.3 * uPitch;
      float th = max(0.6, 0.035 * uPitch);
      float plus = max(
        (1.0 - smoothstep(th - 0.5, th + 0.5, q.y)) * (1.0 - smoothstep(arm - 0.5, arm + 0.5, q.x)),
        (1.0 - smoothstep(th - 0.5, th + 0.5, q.x)) * (1.0 - smoothstep(arm - 0.5, arm + 0.5, q.y)));
      m = 0.45 * plus * (1.0 - smoothstep(uRingR - uRingW, uRingR + uRingW, r));
    } else {
      vec2 blk = floor(px / (1.1 * uPitch));
      float tt = uTime * 4.0;
      float k0 = floor(tt);
      float h = mix(gmHash(blk + k0 * 17.0), gmHash(blk + (k0 + 1.0) * 17.0), smoothstep(0.0, 1.0, tt - k0));
      m = ring * smoothstep(0.55, 0.75, h);
    }
    // light: added to rgb only, so it glows over what is under the pass
    col.rgb = min(col.rgb + uAccentCol * (m * uAccentAmt), vec3(1.0));
  }
  gl_FragColor = col;
}
`;

export const GRADIENT_MAP_PRESET = Object.freeze({
  type: 'Gradient Map',
  name: 'Gradient Map',
  category: 'advanced',
  description: 'The clip turns into a spinning gradient map of itself, then the real picture comes back through the shadows first',
  defaultDuration: 2.5,
  optionDefaults: Object.freeze({
    palette: 'rose',
    color1: GRADIENT_MAP_CUSTOM[0],
    color2: GRADIENT_MAP_CUSTOM[1],
    color3: GRADIENT_MAP_CUSTOM[2],
    color4: GRADIENT_MAP_CUSTOM[3],
    hue: 0,
    lightness: 0,
    saturation: 0,
    spin: 450,
    bandsStart: 1,
    bandsEnd: 1,
    order: 'shadows',
    pointReveal: false,
    point: Object.freeze({ x: 50, y: 50 }),
    pointStrength: 75,
    softness: 50,
    easing: TransitionEasing.LINEAR,
    zoom: 120,
    mapIn: 30,
    swap: 10,
    reveal: 60,
    accent: 'none',
    accentColor: '#ff9342',
    accentStrength: 100,
  }),
  optionFields: Object.freeze([
    Object.freeze({ type: 'section', key: 'sec-palette', label: 'Palette' }),
    Object.freeze({ key: 'palette', label: 'Palette', type: 'select', options: GRADIENT_MAP_PALETTE_OPTIONS }),
    // used by the Custom palette, shadows → highlights (short: the inspector row is narrow)
    Object.freeze({ key: 'color1', label: 'Colour 1', type: 'color' }),
    Object.freeze({ key: 'color2', label: 'Colour 2', type: 'color' }),
    Object.freeze({ key: 'color3', label: 'Colour 3', type: 'color' }),
    Object.freeze({ key: 'color4', label: 'Colour 4', type: 'color' }),
    Object.freeze({ key: 'hue', label: 'Hue', type: 'range', min: -180, max: 180, step: 1, suffix: '°' }),
    Object.freeze({ key: 'lightness', label: 'Lightness', type: 'range', min: -100, max: 100, step: 1 }),
    Object.freeze({ key: 'saturation', label: 'Saturation', type: 'range', min: -100, max: 100, step: 1 }),
    Object.freeze({ key: 'spin', label: 'Palette spin', type: 'range', min: 0, max: 1500, step: 5, suffix: '°/s' }),
    Object.freeze({ key: 'bandsStart', label: 'Bands at start', type: 'range', min: 0.1, max: 10, step: 0.1 }),
    Object.freeze({ key: 'bandsEnd', label: 'Bands at end', type: 'range', min: 0.1, max: 10, step: 0.1 }),
    Object.freeze({ type: 'section', key: 'sec-reveal', label: 'Reveal' }),
    Object.freeze({ key: 'order', label: 'Real picture returns', type: 'select', options: Object.freeze([
      Object.freeze({ value: 'shadows', label: 'Shadows first' }),
      Object.freeze({ value: 'highlights', label: 'Highlights first' }),
    ]) }),
    Object.freeze({ key: 'pointReveal', label: 'Reveal from a point', type: 'switch' }),
    Object.freeze({ key: 'point', label: 'Reveal point', type: 'point' }),
    // the gradient, then the real picture, spread out from the point (like Circular Wipe);
    // 100 % = plain soft circles, lower lets the brightness order show through
    Object.freeze({ key: 'pointStrength', label: 'Point strength', type: 'range', min: 0, max: 100, step: 1, suffix: '%' }),
    Object.freeze({ key: 'softness', label: 'Softness', type: 'range', min: 0, max: 100, step: 1, suffix: '%' }),
    Object.freeze({ key: 'easing', label: 'Easing', type: 'select', options: PIXEL_BLOCKS_EASINGS }),
    Object.freeze({ key: 'zoom', label: 'Zoom', type: 'range', min: 100, max: 200, step: 1, suffix: '%' }),
    Object.freeze({ type: 'section', key: 'sec-timing', label: 'Timing' }),
    // an entrance has no outgoing clip to map, an exit no clip to reveal
    Object.freeze({ key: 'mapIn', label: 'Map in (share)', type: 'range', min: 0, max: 100, step: 1, suffix: '%', inHidden: true }),
    Object.freeze({ key: 'swap', label: 'Swap (share)', type: 'range', min: 0, max: 100, step: 1, suffix: '%' }),
    Object.freeze({ key: 'reveal', label: 'Reveal (share)', type: 'range', min: 0, max: 100, step: 1, suffix: '%', outHidden: true }),
    Object.freeze({ type: 'section', key: 'sec-accent', label: 'Accent' }),
    Object.freeze({ key: 'accent', label: 'Accent', type: 'select', options: Object.freeze([
      Object.freeze({ value: 'none', label: 'None' }),
      Object.freeze({ value: 'dots', label: 'Dot ring' }),
      Object.freeze({ value: 'plus', label: 'Plus grid' }),
      Object.freeze({ value: 'pixels', label: 'Pixel ring' }),
    ]) }),
    Object.freeze({ key: 'accentColor', label: 'Accent colour', type: 'color' }),
    Object.freeze({ key: 'accentStrength', label: 'Accent strength', type: 'range', min: 0, max: 200, step: 1, suffix: '%' }),
  ]),
  createInstance(context) {
    const { THREE } = context;
    const v4 = () => ({ value: new THREE.Vector4(0, 0, 0, 2) });
    const instance = makeTwoTextureInstance(context, 'gradientMap', GRADIENT_MAP_FRAGMENT, {
      uPrevious: { value: null },
      uCurrent: { value: null },
      uRes: { value: new THREE.Vector2(context.width, context.height) },
      uP0: v4(), uP1: v4(), uP2: v4(), uP3: v4(), uP4: v4(), uP5: v4(), uP6: v4(), uP7: v4(), uP8: v4(),
      uPhase: { value: 0 },
      uBands: { value: 1 },
      uSoft: { value: 0.5 },
      uOrder: { value: 0 },
      uMapA: { value: 0 },
      uSwap: { value: 0 },
      uReveal: { value: 0 },
      uZoomA: { value: 1 },
      uZoomB: { value: 1 },
      uExit: { value: 0 },
      uAccent: { value: 0 },
      uAccentCol: { value: new THREE.Vector3(1, 0.576, 0.259) },
      uAccentAmt: { value: 0 },
      uRingR: { value: 0 },
      uRingW: { value: 1 },
      uPitch: { value: 36 },
      uTime: { value: 0 },
      uPoint: { value: new THREE.Vector2(context.width / 2, context.height / 2) },
      uPointMaxD: { value: 1 },
      uPointAmt: { value: 0 },
    });
    // The stops only change with the options, so they are rebuilt on a key, not per frame.
    let stopsKey = '';
    // Both plates and this pass are premultiplied (see makeTwoTextureInstance).
    return {
      resize(size) { instance.resize(size); },
      render(frame) {
        if (!bindFrame(instance, frame)) return;
        const u = instance.material.uniforms;
        const o = frame.options || {};
        const W = Math.max(1, frame.width);
        const H = Math.max(1, frame.height);
        const F = gradientMapFrame(o, frame.rawProgress, frame.slot, frame.duration);
        const key = `${o.palette}|${o.color1}|${o.color2}|${o.color3}|${o.color4}|${o.hue}|${o.lightness}|${o.saturation}`;
        if (key !== stopsKey) {
          stopsKey = key;
          for (let i = 0; i <= GRADIENT_MAP_MAX_STOPS; i += 1) {
            const s = F.stops[i];
            if (s) u[`uP${i}`].value.set(s[0], s[1], s[2], s[3]);
            else if (i === F.stops.length) u[`uP${i}`].value.set(F.stops[0][0], F.stops[0][1], F.stops[0][2], 1);
            else u[`uP${i}`].value.set(0, 0, 0, 2);
          }
        }
        u.uRes.value.set(W, H);
        u.uPhase.value = F.phase;
        u.uBands.value = F.bands;
        u.uSoft.value = F.soft;
        u.uOrder.value = F.order;
        u.uMapA.value = F.mapA;
        u.uSwap.value = F.swap;
        u.uReveal.value = F.reveal;
        u.uZoomA.value = F.zoomA;
        u.uZoomB.value = F.zoomB;
        u.uExit.value = frame.slot === 'out' ? 1 : 0;
        const P = gradientMapPoint(o, W, H);
        u.uPoint.value.set(P.x, P.y);
        u.uPointMaxD.value = P.maxD;
        u.uPointAmt.value = P.amt;
        u.uAccent.value = F.accent;
        u.uAccentAmt.value = F.accent ? F.accentAmt : 0;
        if (F.accent) {
          const k = Math.min(W, H) / 1080;   // authored on 1080p, so preview and export match
          const accent = glowRgb(o.accentColor, '#ff9342');
          u.uAccentCol.value.set(accent[0], accent[1], accent[2]);
          u.uRingR.value = F.accentRing * 1.15 * 0.5 * Math.hypot(W, H);
          u.uRingW.value = 120 * k;
          u.uPitch.value = Math.max(4, 36 * k);
          u.uTime.value = F.timeSec;
        }
      },
      dispose() { instance.dispose(); },
    };
  },
});
