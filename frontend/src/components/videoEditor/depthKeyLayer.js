import * as THREE from 'three';
import { setFxBoxUniforms } from './homography.js';
import { getDepthMapEffect, hasDepthSource, resolveDepthMapParams } from './depthMapEffect.js';

/*
 * Depth Matte (`depthKey`) — After Effects-style Depth Matte / Depth Keyer.
 *
 * Keys pixels by scene depth so background replacement, sandwitching 3D text
 * or layers between foreground & background planes, and slice isolation work
 * identically over either a frozen Depth Map OR a per-frame stabilized Video Depth.
 *
 * Works cleanly on both WebGL (createDepthKeyMaterial here) and WebGPU
 * (depthKeyNodes.js createDepthKeyNodeMaterial via screenCoordinate + uFxHomInv).
 */

export const DEPTH_KEY_LAYER_EFFECT_ID = 'depthKey';
export const DK_IS_PRO = false;

export const DK_MODES = ['foreground', 'background', 'band'];
export const DK_VIEWS = ['final', 'matte', 'cut', 'zone'];

export const DK_DEFAULTS = {
  dkMode: 'foreground',   // 'foreground' | 'background' | 'band'
  dkDepth: 50,            // 0..100 cut plane (near=100, far=0)
  dkFeather: 6,           // 0..50 softness width (%)
  dkBandWidth: 18,        // 1..100 depth band width (%)
  dkGamma: 1.0,           // 0.25..4.0 depth remap curve
  dkEdgeSnap: 35,         // 0..100 RGB-guided bilateral edge snap (%)
  dkChoke: 0,             // -10..+10 px matte choke (+) / spread (-)
  dkInvert: 0,            // 0 | 1
  dkMix: 100,             // 0..100 master mix (%)
  dkView: 'final',        // 'final' | 'matte' | 'cut' | 'zone'
  dkFollowLayerId: '',    // optional 3D Text / 3D Model layer ID whose camera-Z drives cut
  dkFollowOffset: 0,      // -50..+50 depth cut bias when following a 3D layer (%)
};

export const DK_NUMBER_FIELDS = [
  { key: 'dkDepth', label: 'Depth', min: 0, max: 100, step: 0.1, suffix: '%', kf: true },
  { key: 'dkBandWidth', label: 'Band Width', min: 1, max: 100, step: 0.1, suffix: '%', kf: true },
  { key: 'dkFeather', label: 'Feather', min: 0, max: 50, step: 0.1, suffix: '%', kf: true },
  { key: 'dkGamma', label: 'Depth Curve', min: 0.25, max: 4.0, step: 0.01, kf: false },
  { key: 'dkEdgeSnap', label: 'Edge Snap', min: 0, max: 100, step: 1, suffix: '%', kf: false },
  { key: 'dkChoke', label: 'Matte Choke', min: -10, max: 10, step: 0.1, suffix: 'px', kf: true },
  { key: 'dkMix', label: 'Mix', min: 0, max: 100, step: 1, suffix: '%', kf: true },
  { key: 'dkFollowOffset', label: 'Follow Z Offset', min: -50, max: 50, step: 0.1, suffix: '%', kf: true },
];

export const DK_ENUM_FIELDS = [
  {
    key: 'dkMode',
    label: 'Keep',
    options: [
      ['foreground', 'Foreground'],
      ['background', 'Background'],
      ['band', 'Depth Band'],
    ],
  },
  {
    key: 'dkInvert',
    label: 'Invert Matte',
    options: [[0, 'Off'], [1, 'On']],
  },
  {
    key: 'dkView',
    label: 'View',
    options: [
      ['final', 'Final'],
      ['matte', 'Matte'],
      ['cut', 'Depth + Cut'],
      ['zone', 'Zone Highlight'],
    ],
  },
];

export const DK_STRING_FIELDS = [
  { key: 'dkFollowLayerId', label: 'Follow 3D Layer Z', maxLength: 120 },
];

export function getDepthKeyEffect(item) {
  const list = item?.layerEffects;
  if (!Array.isArray(list)) return null;
  return list.find((effect) => effect?.id === DEPTH_KEY_LAYER_EFFECT_ID) || null;
}

export function isDepthKeyEnabled(item) {
  const effect = getDepthKeyEffect(item);
  return !!effect && effect.enabled !== false && hasDepthSource(item);
}

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

export function resolveDepthKeyParams(item, keyframeProps) {
  const params = getDepthKeyEffect(item)?.params || {};
  const n = (k, def, min, max) => {
    const kf = keyframeProps && Number.isFinite(Number(keyframeProps[k])) ? Number(keyframeProps[k]) : undefined;
    const raw = kf !== undefined ? kf : (Number.isFinite(Number(params[k])) ? Number(params[k]) : def);
    return clamp(raw, min, max);
  };
  return {
    dkMode: DK_MODES.includes(params.dkMode) ? params.dkMode : DK_DEFAULTS.dkMode,
    dkDepth: n('dkDepth', DK_DEFAULTS.dkDepth, 0, 100),
    dkFeather: n('dkFeather', DK_DEFAULTS.dkFeather, 0, 50),
    dkBandWidth: n('dkBandWidth', DK_DEFAULTS.dkBandWidth, 1, 100),
    dkGamma: n('dkGamma', DK_DEFAULTS.dkGamma, 0.25, 4.0),
    dkEdgeSnap: n('dkEdgeSnap', DK_DEFAULTS.dkEdgeSnap, 0, 100),
    dkChoke: n('dkChoke', DK_DEFAULTS.dkChoke, -10, 10),
    dkInvert: Number(params.dkInvert) >= 0.5 ? 1 : 0,
    dkMix: n('dkMix', DK_DEFAULTS.dkMix, 0, 100),
    dkView: DK_VIEWS.includes(params.dkView) ? params.dkView : DK_DEFAULTS.dkView,
    dkFollowLayerId: typeof params.dkFollowLayerId === 'string' ? params.dkFollowLayerId.slice(0, 120) : '',
    dkFollowOffset: n('dkFollowOffset', DK_DEFAULTS.dkFollowOffset, -50, 50),
  };
}

/**
 * Project a 3D target layer's camera-space distance (`viewDistancePx` in composition
 * px, where 1000 px = 1 metre) into Depth Matte's 0..100 cut coordinate space
 * (disparity-proportional: 100 = near plane `depthNearM`, 0 = far plane `depthFarM`).
 */
export function computeFollowLayerDepth({
  viewDistancePx, depthNearM = 0.4, depthFarM = 8.0, followOffset = 0,
}) {
  if (!Number.isFinite(viewDistancePx) || !(viewDistancePx > 0)) return null;
  const nearM = Math.max(0.05, Number(depthNearM) || 0.4);
  const farM = Math.max(nearM + 0.1, Number(depthFarM) || 8.0);
  const distM = Math.max(nearM, Math.min(farM, viewDistancePx * 0.001));
  const invNear = 1 / nearM;
  const invFar = 1 / farM;
  const disparity01 = (1 / distM - invFar) / Math.max(1e-6, invNear - invFar);
  return clamp(disparity01 * 100 + (Number(followOffset) || 0), 0, 100);
}

// ── GLSL (WebGL fallback) ────────────────────────────────────────────────────

const DK_VERTEX = /* glsl */`
  void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const DK_FRAGMENT = /* glsl */`
precision highp float;
uniform sampler2D uTexture;    // premultiplied RGBA isolate
uniform sampler2D uDepth;
uniform vec2 uResolution;
uniform vec2 uDepthSize;
uniform vec2 uFxOrigin;
uniform vec2 uFxAxisX;
uniform vec2 uFxAxisY;
uniform mat3 uFxHom;
uniform mat3 uFxHomInv;
uniform float uInvert;
uniform float uMode;           // 0 = foreground, 1 = background, 2 = band
uniform float uDepthCut;       // 0..1
uniform float uFeather;        // 0..0.5
uniform float uBandWidth;      // 0.01..1.0
uniform float uGamma;          // 0.25..4.0
uniform float uEdgeSnap;       // 0..1
uniform float uChoke;          // -10..+10 px
uniform float uKeyInvert;      // 0 | 1
uniform float uMix;            // 0..1
uniform float uView;           // 0 final, 1 matte, 2 cut, 3 zone

vec2 fxLocal(vec2 uvn) {
  vec3 h = uFxHomInv * vec3(uvn, 1.0);
  if (h.z < 1e-6) return vec2(-1e3);
  return h.xy / h.z;
}

float readDepthRaw(vec2 p) {
  float d = texture2D(uDepth, clamp(p, 0.0, 1.0)).r;
  if (uInvert > 0.5) d = 1.0 - d;
  return pow(clamp(d, 0.0, 1.0), max(0.05, uGamma));
}

float evalMatte(float d) {
  float hw = max(0.001, uFeather * 0.5);
  float m;
  if (uMode < 0.5) {
    m = smoothstep(uDepthCut - hw, uDepthCut + hw, d);
  } else if (uMode < 1.5) {
    m = 1.0 - smoothstep(uDepthCut - hw, uDepthCut + hw, d);
  } else {
    float bwHalf = max(0.005, uBandWidth * 0.5);
    m = 1.0 - smoothstep(bwHalf - hw, bwHalf + hw, abs(d - uDepthCut));
  }
  if (uKeyInvert > 0.5) m = 1.0 - m;
  return clamp(m, 0.0, 1.0);
}

void main() {
  vec2 uvn = gl_FragCoord.xy / max(vec2(1.0), uResolution);
  vec4 s = texture2D(uTexture, uvn);
  float cov = s.a;
  if (cov <= 1e-5) {
    gl_FragColor = vec4(0.0);
    return;
  }
  vec3 src = s.rgb / cov;

  vec2 p = fxLocal(uvn);
  float d = readDepthRaw(p);

  if (uEdgeSnap > 0.001) {
    vec2 stepUv = 1.5 / max(vec2(1.0), uResolution);
    float sumW = 0.0;
    float sumD = 0.0;
    for (int oy = -1; oy <= 1; oy++) {
      for (int ox = -1; ox <= 1; ox++) {
        vec2 nUvn = clamp(uvn + vec2(float(ox), float(oy)) * stepUv, 0.0, 1.0);
        vec4 nCol = texture2D(uTexture, nUvn);
        vec3 nRgb = nCol.a > 1e-4 ? nCol.rgb / nCol.a : src;
        vec3 dc = nRgb - src;
        float wc = exp(-dot(dc, dc) / 0.018);
        float ws = (ox == 0 && oy == 0) ? 1.0 : ((abs(ox) + abs(oy) == 1) ? 0.7 : 0.45);
        float w = ws * wc;
        sumW += w;
        sumD += w * readDepthRaw(fxLocal(nUvn));
      }
    }
    float snapped = sumD / max(1e-5, sumW);
    d = mix(d, snapped, clamp(uEdgeSnap, 0.0, 1.0));
  }

  float m = evalMatte(d);

  if (abs(uChoke) > 0.01) {
    vec2 rad = abs(uChoke) / max(vec2(1.0), uResolution);
    float ext = m;
    float shrink = uChoke > 0.0 ? 1.0 : 0.0;
    for (int i = 0; i < 8; i++) {
      vec2 dir;
      if (i == 0) dir = vec2(1.0, 0.0);
      else if (i == 1) dir = vec2(-1.0, 0.0);
      else if (i == 2) dir = vec2(0.0, 1.0);
      else if (i == 3) dir = vec2(0.0, -1.0);
      else if (i == 4) dir = vec2(0.7071, 0.7071);
      else if (i == 5) dir = vec2(-0.7071, 0.7071);
      else if (i == 6) dir = vec2(0.7071, -0.7071);
      else dir = vec2(-0.7071, -0.7071);
      float mn = evalMatte(readDepthRaw(fxLocal(clamp(uvn + dir * rad, 0.0, 1.0))));
      ext = shrink > 0.5 ? min(ext, mn) : max(ext, mn);
    }
    m = mix(m, ext, clamp(abs(uChoke), 0.0, 1.0));
  }

  float keep = mix(1.0, m, clamp(uMix, 0.0, 1.0));

  if (uView > 2.5) {
    // Zone Highlight: kept tinted green, removed tinted muted red
    vec3 keptCol = mix(src, vec3(0.32, 0.95, 0.48), 0.25);
    vec3 cutCol = mix(src * 0.45, vec3(0.85, 0.2, 0.25), 0.45);
    vec3 zoneRgb = mix(cutCol, keptCol, keep);
    gl_FragColor = vec4(zoneRgb * cov, cov);
    return;
  }
  if (uView > 1.5) {
    // Depth + Cut plane overlay
    float cutTol = max(0.008, uFeather * 0.15);
    float line = 1.0 - smoothstep(0.0, cutTol, abs(d - uDepthCut));
    vec3 dbg = mix(vec3(d), vec3(1.0, 0.2, 0.8), line);
    gl_FragColor = vec4(dbg * cov, cov);
    return;
  }
  if (uView > 0.5) {
    // Matte only
    gl_FragColor = vec4(vec3(keep) * cov, cov);
    return;
  }

  float outA = cov * keep;
  gl_FragColor = vec4(clamp(src * outA, 0.0, 1.0), clamp(outA, 0.0, 1.0));
}
`;

export function createDepthKeyMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader: DK_VERTEX,
    fragmentShader: DK_FRAGMENT,
    uniforms: {
      uTexture: { value: null },
      uDepth: { value: null },
      uResolution: { value: new THREE.Vector2(1280, 720) },
      uDepthSize: { value: new THREE.Vector2(384, 216) },
      uFxOrigin: { value: new THREE.Vector2(0.5, 0.5) },
      uFxAxisX: { value: new THREE.Vector2(0.5, 0) },
      uFxAxisY: { value: new THREE.Vector2(0, 0.5) },
      uFxHom: { value: new THREE.Matrix3() },
      uFxHomInv: { value: new THREE.Matrix3() },
      uInvert: { value: 0 },
      uMode: { value: 0 },
      uDepthCut: { value: 0.5 },
      uFeather: { value: 0.06 },
      uBandWidth: { value: 0.18 },
      uGamma: { value: 1.0 },
      uEdgeSnap: { value: 0.35 },
      uChoke: { value: 0 },
      uKeyInvert: { value: 0 },
      uMix: { value: 1.0 },
      uView: { value: 0 },
    },
    transparent: true,
    blending: THREE.NoBlending,
    depthTest: false,
    depthWrite: false,
  });
}

export function applyDepthKeyUniforms(material, params, {
  width, height, box, depthTexture, depthSize, invert, resolvedDepthCut = null,
}) {
  const u = material.uniforms;
  u.uResolution.value.set(width, height);
  u.uDepthSize.value.set(Math.max(1, depthSize?.[0] || 384), Math.max(1, depthSize?.[1] || 216));
  setFxBoxUniforms(u, box);
  u.uDepth.value = depthTexture || null;
  u.uInvert.value = invert ? 1 : 0;
  const modeIdx = DK_MODES.indexOf(params.dkMode);
  u.uMode.value = modeIdx >= 0 ? modeIdx : 0;
  const cutPct = resolvedDepthCut != null ? resolvedDepthCut : params.dkDepth;
  u.uDepthCut.value = clamp((Number(cutPct) || 0) / 100, 0, 1);
  u.uFeather.value = clamp((Number(params.dkFeather) || 0) / 100, 0, 0.5);
  u.uBandWidth.value = clamp((Number(params.dkBandWidth) || 18) / 100, 0.01, 1.0);
  u.uGamma.value = clamp(Number(params.dkGamma) || 1, 0.25, 4.0);
  u.uEdgeSnap.value = clamp((Number(params.dkEdgeSnap) || 0) / 100, 0, 1);
  u.uChoke.value = clamp(Number(params.dkChoke) || 0, -10, 10);
  u.uKeyInvert.value = Number(params.dkInvert) >= 0.5 ? 1 : 0;
  u.uMix.value = clamp((Number(params.dkMix) || 0) / 100, 0, 1);
  const viewIdx = DK_VIEWS.indexOf(params.dkView);
  u.uView.value = viewIdx >= 0 ? viewIdx : 0;
}
