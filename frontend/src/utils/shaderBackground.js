// GLSL shader backgrounds for the Video Editor.
//
// A tiny raw-WebGL1 renderer that runs Shadertoy-style fragment shaders
// (a `void mainImage(out vec4 fragColor, in vec2 fragCoord)` entry point) with
// the common Shadertoy uniforms (iResolution / iTime / iTimeDelta / iFrameRate /
// iFrame / iMouse / iDate). It draws a single fullscreen triangle into its own <canvas>, which
// callers blit into the 2D background/shape canvas via ctx.drawImage — so the
// same code path feeds live preview and the deterministic WebCodecs export
// (time is passed in explicitly, never read from a wall clock here).
//
// Shaders are cached per usage-key so a stable consumer (project background,
// a given shape, the settings thumbnail) keeps one GL context at one size
// instead of thrashing. Textures / iChannels are intentionally unsupported.

import { LAB_SHADER_PRESETS } from './shaderPresetsLab.js';

const VERTEX_SRC = `attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FRAG_PRELUDE = `#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec3 iResolution;
uniform float iTime;
uniform float iTimeDelta;
uniform float iFrameRate;
uniform int iFrame;
uniform vec4 iMouse;
uniform vec4 iDate;
uniform float uShaderZoom;
`;

// The wrapper feeds mainImage() a fragCoord scaled around the frame centre so
// `uShaderZoom` zooms the pattern itself (bigger features), independent of the
// buffer-resolution `shaderScale`. Guarded against 0 because a caller that
// never sets the uniform reads GL's default 0.0 — that must mean "no zoom",
// not a divide-by-zero.
const MAIN_WRAPPER = `
void main() {
  vec4 fragColor = vec4(0.0, 0.0, 0.0, 1.0);
  float _z = uShaderZoom > 0.0 ? uShaderZoom : 1.0;
  vec2 _fc = (gl_FragCoord.xy - 0.5 * iResolution.xy) / _z + 0.5 * iResolution.xy;
  mainImage(fragColor, _fc);
  gl_FragColor = vec4(fragColor.rgb, fragColor.a);
}
`;

// Build a compilable GLSL ES 1.00 fragment shader from user/preset code.
// Shadertoy snippets expose mainImage() → we append a main() wrapper.
// A raw shader that already defines main() is used mostly as-is.
//
// `opts.prelude` / `opts.wrapper` override the default Shadertoy prelude and
// main() wrapper (default = today's, so shader backgrounds are untouched). This
// lets other consumers — e.g. the adjustment-layer custom-effect slot, whose
// prelude binds iChannel0 to the layers-below texture — reuse this exact
// compile path instead of duplicating the harness.
// A pasted shader may bring its own declaration of a name the prelude also
// declares (`uniform vec3 iResolution;` is common in Shadertoy→WebGL1 ports).
// GLSL treats that as a redefinition error, so the prelude drops just those
// lines. Duplicate `precision` statements are legal and are left alone.
const GLSL_TYPE = 'float|int|bool|vec2|vec3|vec4|ivec2|ivec3|ivec4|bvec2|bvec3|bvec4|mat2|mat3|mat4|sampler2D|samplerCube';
const QUALIFIERS = '(?:uniform|varying|attribute|const|in|out)?\\s*(?:lowp|mediump|highp)?\\s*';
const PRELUDE_DECL_RE = new RegExp(`^\\s*${QUALIFIERS}(?:${GLSL_TYPE})\\s+([A-Za-z_]\\w*)\\s*(?:\\[[^\\]]*\\])?\\s*[;=]`);
const BODY_DECL_RE = new RegExp(`(?:^|;)\\s*${QUALIFIERS}(?:${GLSL_TYPE})\\s+([A-Za-z_]\\w*)\\s*(?:\\[[^\\]]*\\])?\\s*[;=]`, 'g');

// Names declared at top level in `src` (comments stripped, brace depth 0 only —
// a local named `iTime` inside some function must not shadow the prelude's).
function topLevelDeclarations(src) {
  const clean = String(src || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
  const names = new Set();
  let depth = 0;
  for (const line of clean.split('\n')) {
    if (depth === 0) {
      BODY_DECL_RE.lastIndex = 0;
      let m;
      while ((m = BODY_DECL_RE.exec(line))) names.add(m[1]);
    }
    for (const ch of line) {
      if (ch === '{') depth++;
      else if (ch === '}') depth = Math.max(0, depth - 1);
    }
  }
  return names;
}

// Prelude minus every declaration `body` already makes for itself.
export function mergePrelude(prelude, body) {
  const pre = String(prelude || '');
  if (!pre) return '';
  const declared = topLevelDeclarations(body);
  if (!declared.size) return pre;
  return pre
    .split('\n')
    .filter((line) => {
      const m = line.match(PRELUDE_DECL_RE);
      return !(m && declared.has(m[1]));
    })
    .join('\n');
}

export function buildFragmentSource(code, opts = {}) {
  const body = String(code || '');
  const prelude = mergePrelude(opts.prelude != null ? opts.prelude : FRAG_PRELUDE, body);
  const wrapper = opts.wrapper != null ? opts.wrapper : MAIN_WRAPPER;
  const hasMainImage = /\bvoid\s+mainImage\s*\(/.test(body);
  const hasMain = /\bvoid\s+main\s*\(/.test(body);
  if (hasMainImage) return `${prelude}\n${body}\n${wrapper}`;
  // A raw shader that brings its own main() still gets the uniform block. This
  // used to drop the prelude wholesale whenever the body set its own precision,
  // which left iResolution/iTime undeclared for most hand-converted pastes.
  if (hasMain) return `${prelude}\n${body}`;
  // Not recognizable — wrap as a passthrough so compile fails cleanly with a message.
  return `${prelude}\n${body}\n${wrapper}`;
}

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh) || 'shader compile error';
    gl.deleteShader(sh);
    return { shader: null, error: log };
  }
  return { shader: sh, error: null };
}

export function createShaderRenderer(code, opts = {}) {
  const canvas = opts.canvas || document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(opts.width || 320));
  canvas.height = Math.max(1, Math.round(opts.height || 180));
  const gl = canvas.getContext('webgl', {
    premultipliedAlpha: false,
    preserveDrawingBuffer: true,
    antialias: false,
    depth: false,
    stencil: false,
  }) || canvas.getContext('experimental-webgl');

  const state = {
    canvas,
    gl,
    program: null,
    uniforms: {},
    error: gl ? null : 'WebGL is not available',
  };

  if (!gl) return makeApi(state);

  // Fullscreen triangle.
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  state.buffer = buf;

  function link(src) {
    const vs = compile(gl, gl.VERTEX_SHADER, VERTEX_SRC);
    if (vs.error) return { error: `vertex: ${vs.error}` };
    const fs = compile(gl, gl.FRAGMENT_SHADER, src);
    if (fs.error) { gl.deleteShader(vs.shader); return { error: fs.error }; }
    const prog = gl.createProgram();
    gl.attachShader(prog, vs.shader);
    gl.attachShader(prog, fs.shader);
    gl.bindAttribLocation(prog, 0, 'aPos');
    gl.linkProgram(prog);
    gl.deleteShader(vs.shader);
    gl.deleteShader(fs.shader);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(prog) || 'link error';
      gl.deleteProgram(prog);
      return { error: log };
    }
    return { program: prog };
  }

  function applyProgram(newCode) {
    const src = buildFragmentSource(newCode, { prelude: opts.prelude, wrapper: opts.wrapper });
    const res = link(src);
    if (res.error) {
      state.error = res.error.trim();
      return;
    }
    if (state.program) gl.deleteProgram(state.program);
    state.program = res.program;
    state.error = null;
    state.paramLocs = {}; // per-program cache for preset-param uniforms
    state.uniforms = {
      uShaderZoom: gl.getUniformLocation(state.program, 'uShaderZoom'),
      iResolution: gl.getUniformLocation(state.program, 'iResolution'),
      iTime: gl.getUniformLocation(state.program, 'iTime'),
      iTimeDelta: gl.getUniformLocation(state.program, 'iTimeDelta'),
      iFrameRate: gl.getUniformLocation(state.program, 'iFrameRate'),
      iFrame: gl.getUniformLocation(state.program, 'iFrame'),
      iMouse: gl.getUniformLocation(state.program, 'iMouse'),
      iDate: gl.getUniformLocation(state.program, 'iDate'),
    };
    const loc = gl.getAttribLocation(state.program, 'aPos');
    state.attrib = loc < 0 ? 0 : loc;
  }

  state._applyProgram = applyProgram;
  applyProgram(code);
  return makeApi(state);
}

function makeApi(state) {
  const api = {
    canvas: state.canvas,
    get error() { return state.error; },
    setCode(code) {
      if (state._applyProgram) state._applyProgram(code);
      return state.error;
    },
    resize(w, h) {
      const nw = Math.max(1, Math.round(w));
      const nh = Math.max(1, Math.round(h));
      if (state.canvas.width !== nw) state.canvas.width = nw;
      if (state.canvas.height !== nh) state.canvas.height = nh;
    },
    // Render one frame at absolute time `time` (seconds). Returns the canvas.
    // `extra.zoom` scales the pattern (see MAIN_WRAPPER); `extra.params` is a
    // {uniformName: number | [x,y] | [x,y,z] | [x,y,z,w]} map for preset params.
    render(time = 0, mouse = null, extra = null) {
      const { gl } = state;
      if (!gl || !state.program) return state.canvas;
      const W = state.canvas.width;
      const H = state.canvas.height;
      gl.viewport(0, 0, W, H);
      gl.useProgram(state.program);
      gl.bindBuffer(gl.ARRAY_BUFFER, state.buffer);
      gl.enableVertexAttribArray(state.attrib);
      gl.vertexAttribPointer(state.attrib, 2, gl.FLOAT, false, 0, 0);
      const u = state.uniforms;
      if (u.iResolution) gl.uniform3f(u.iResolution, W, H, 1);
      if (u.iTime) gl.uniform1f(u.iTime, time);
      if (u.iTimeDelta) gl.uniform1f(u.iTimeDelta, 1 / 60);
      if (u.iFrameRate) gl.uniform1f(u.iFrameRate, 60);
      // Derive iFrame from timeline time instead of render-call count. Seeking,
      // pausing, previewing, and exporting the same timestamp must produce the
      // same shader frame regardless of what was rendered beforehand.
      if (u.iFrame) gl.uniform1i(u.iFrame, Math.max(0, Math.floor(time * 60 + 1e-6)));
      if (u.iMouse) {
        const m = mouse || [0, 0, 0, 0];
        gl.uniform4f(u.iMouse, m[0], m[1], m[2], m[3]);
      }
      if (u.iDate) gl.uniform4f(u.iDate, 0, 0, 0, time);
      if (u.uShaderZoom) {
        const z = Number(extra?.zoom);
        gl.uniform1f(u.uShaderZoom, Number.isFinite(z) && z > 0 ? z : 1);
      }
      const params = extra?.params;
      if (params) {
        for (const key of Object.keys(params)) {
          let loc = state.paramLocs[key];
          if (loc === undefined) {
            loc = gl.getUniformLocation(state.program, key);
            state.paramLocs[key] = loc;
          }
          if (!loc) continue; // uniform absent (custom code, renamed, or optimized out)
          const v = params[key];
          if (typeof v === 'number') { if (Number.isFinite(v)) gl.uniform1f(loc, v); }
          else if (Array.isArray(v)) {
            if (v.length === 2) gl.uniform2f(loc, v[0], v[1]);
            else if (v.length === 3) gl.uniform3f(loc, v[0], v[1], v[2]);
            else if (v.length === 4) gl.uniform4f(loc, v[0], v[1], v[2], v[3]);
          }
        }
      }
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      return state.canvas;
    },
    dispose() {
      const { gl } = state;
      if (!gl) return;
      try {
        if (state.program) gl.deleteProgram(state.program);
        if (state.buffer) gl.deleteBuffer(state.buffer);
        const ext = gl.getExtension('WEBGL_lose_context');
        if (ext) ext.loseContext();
      } catch { /* no-op */ }
      state.program = null;
    },
  };
  return api;
}

// ── Shared renderer cache ─────────────────────────────────────────────────
// Keyed by an arbitrary usage tag (so project-bg / a shape / the preview thumb
// don't fight over one GL context and size). LRU-capped to bound GL contexts.
const CACHE = new Map(); // key -> { renderer, code, lastUsed }
const MAX_RENDERERS = 12;

function evictIfNeeded() {
  if (CACHE.size <= MAX_RENDERERS) return;
  let oldestKey = null;
  let oldest = Infinity;
  for (const [k, v] of CACHE) {
    if (v.lastUsed < oldest) { oldest = v.lastUsed; oldestKey = k; }
  }
  if (oldestKey != null) {
    try { CACHE.get(oldestKey).renderer.dispose(); } catch { /* no-op */ }
    CACHE.delete(oldestKey);
  }
}

let seq = 0;
function getRenderer(usageKey, code, W, H) {
  const key = `${usageKey}`;
  let entry = CACHE.get(key);
  if (!entry) {
    const renderer = createShaderRenderer(code, { width: W, height: H });
    entry = { renderer, code };
    CACHE.set(key, entry);
    evictIfNeeded();
  } else if (entry.code !== code) {
    entry.renderer.setCode(code);
    entry.code = code;
  }
  entry.renderer.resize(W, H);
  entry.lastUsed = seq++;
  return entry.renderer;
}

// Render `code` at `time` and blit it into a 2D context (W×H). Returns the
// renderer's compile error string (or null). Draws nothing extra on error so
// the caller's base fill shows through.
export function drawShaderToContext(ctx, W, H, code, time, opts = {}) {
  if (!ctx || W <= 0 || H <= 0) return 'invalid target';
  // Key by usage only (not code) so a stable consumer keeps ONE GL context and
  // recompiles in place when its code changes — live editing never leaks contexts.
  const usageKey = opts.usageKey || 'default';
  // Cap internal render resolution so 4K exports don't allocate a 4K GL buffer
  // for a smooth gradient; scaled up on blit, shader backgrounds stay smooth.
  const maxDim = opts.maxDim || 1920;
  const scale = Math.min(1, maxDim / Math.max(W, H));
  const rw = Math.max(1, Math.round(W * scale));
  const rh = Math.max(1, Math.round(H * scale));
  const renderer = getRenderer(usageKey, code, rw, rh);
  if (renderer.error) return renderer.error;
  renderer.render(time, opts.mouse, { zoom: opts.zoom, params: opts.params });
  try {
    ctx.drawImage(renderer.canvas, 0, 0, W, H);
  } catch { /* context may be lost mid-frame */ }
  return null;
}

// ── Render scale ──────────────────────────────────────────────────────────
// Shadertoy shaders overwhelmingly work in PIXEL units (fragCoord, distances
// measured in px), so their look is tied to the size of the buffer they render
// into, not to the frame they eventually fill. A shader that reads well in a
// 320px preview can dissolve into a few stray pixels across a 1080p background.
// `shaderScale` renders it smaller and lets the blit upscale, which is what
// makes those shaders usable at full frame size — at the cost of sharpness.
//
// This belongs on the background CONFIG rather than a call-site option: the
// config reaches live preview, shape backgrounds and the WebCodecs/headless
// export alike, so they cannot disagree on the buffer size. An option would
// have to be threaded to every call site, and one missed call site surfaces as
// an export that doesn't match what the preview showed.
export const SHADER_SCALES = [
  { value: 1, label: 'Full' },
  { value: 0.5, label: 'Half' },
  { value: 0.25, label: 'Quarter' },
  { value: 0.125, label: 'Eighth' },
];

// Effective maxDim for a config, given the target size and the caller's cap.
// At scale 1 this returns `cap` unchanged for any canvas the cap already
// bounded, so existing projects render exactly as they did.
export function shaderMaxDim(W, H, config, cap) {
  const raw = Number(config?.shaderScale);
  const s = Number.isFinite(raw) ? Math.min(1, Math.max(0.05, raw)) : 1;
  return Math.max(16, Math.round(Math.min(cap, Math.max(W, H) * s)));
}

// ── Preset parameters ─────────────────────────────────────────────────────
// Presets may declare `params`: [{key, label, type: 'color'|'range', default,
// min, max, step}]. `key` is the GLSL uniform name the preset's code declares.
// Chosen values live on the background config as `shaderParams[key]` in
// UI-native form (hex string / number); they are resolved to uniform values
// (vec3 / float) right before draw so the config stays JSON-friendly.

export function hexToVec3(hex) {
  const str = String(hex || '').trim();
  const rgbaMatch = str.match(/^rgba?\(([^)]+)\)$/i);
  if (rgbaMatch) {
    const [r, g, b] = rgbaMatch[1].split(',').map((x) => Number(x));
    return [r, g, b].map((x) => (Number.isFinite(x) ? Math.min(255, Math.max(0, x)) / 255 : 1));
  }
  const s = str.replace('#', '');
  const full = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
  const n = parseInt(full.slice(0, 6), 16);
  if (!Number.isFinite(n) || full.length < 6) return [1, 1, 1];
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

// UI-native param values for a config: preset defaults overlaid with the
// config's stored choices. Used by the panel (control values) and as the
// snapshot baked into shaderParams when preset code is edited into custom code
// (so the uniforms in the copied code keep their values).
// Layers, lowest first: the preset defaults, then the named look in
// `shaderLook` (an id from preset.looks — stored by id so a project never copies
// a look's values), then the per-param overrides in `shaderParams`.
export function shaderParamValues(config) {
  const preset = getShaderPreset(config?.shaderId);
  const stored = config && typeof config.shaderParams === 'object' && config.shaderParams ? config.shaderParams : {};
  const look = config?.shaderLook && preset?.looks ? preset.looks.find((l) => l.id === config.shaderLook) : null;
  const lookValues = look ? look.values : {};
  const out = {};
  if (preset?.params) {
    for (const def of preset.params) {
      out[def.key] = stored[def.key] != null ? stored[def.key]
        : lookValues[def.key] != null ? lookValues[def.key] : def.default;
    }
  }
  for (const k of Object.keys(stored)) if (!(k in out)) out[k] = stored[k];
  return out;
}

// Uniform map ({name: float | [r,g,b]}) ready for drawShaderToContext's
// opts.params. Works for custom code too: stored values pass through, with
// '#hex' strings converted to vec3.
export function resolveShaderParams(config) {
  const values = shaderParamValues(config);
  const preset = getShaderPreset(config?.shaderId);
  const types = {};
  if (preset?.params) for (const def of preset.params) types[def.key] = def.type;
  const out = {};
  for (const [k, v] of Object.entries(values)) {
    const isColor = types[k] === 'color' || (typeof v === 'string' && v.trim().startsWith('#'));
    out[k] = isColor ? hexToVec3(v) : Number(v);
  }
  return out;
}

// The GLSL a background config runs. A config's `shaderCode` is a SNAPSHOT of
// the preset taken when it was picked, so a project saved before a preset
// gained params would keep compiling the old source, and the new controls would
// write uniforms that source never declares. A built-in preset therefore runs
// the registry's current source; its defaults reproduce the old look, so
// nothing moves until a control is touched. Stored code that is not a copy of
// the named preset (its first line, the preset's name comment, differs) is
// someone's own shader and runs as stored.
const firstLine = (s) => String(s).trimStart().split('\n', 1)[0].trim();
export function shaderCodeFor(config) {
  const stored = config?.shaderCode;
  const preset = getShaderPreset(config?.shaderId);
  if (preset && (!stored || firstLine(stored) === firstLine(preset.code))) return preset.code;
  return stored || DEFAULT_SHADER_CODE;
}

// Compile-check a shader without keeping it around. Returns error string or null.
// `opts.prelude` / `opts.wrapper` are threaded through so callers with a custom
// harness (e.g. the adjustment-effect custom slot) validate against their own
// uniform set.
export function validateShaderCode(code, opts = {}) {
  const r = createShaderRenderer(code, { width: 8, height: 8, prelude: opts.prelude, wrapper: opts.wrapper });
  const err = r.error;
  r.dispose();
  return err;
}

export function disposeShaderRenderer(usageKey) {
  const entry = CACHE.get(usageKey);
  if (entry) { try { entry.renderer.dispose(); } catch { /* no-op */ } CACHE.delete(usageKey); }
}

// ── Presets ───────────────────────────────────────────────────────────────
// GLSL ES 1.00 (WebGL1) compatible. Each defines a Shadertoy mainImage().
//
// A preset may also carry `looks`: named param sets ({ id, name, values }) the
// panel offers as one-click presets; looks[0] equals the param defaults. A
// param may be type 'select' ({ options: [{ value, label }] }) — a float uniform
// holding the option value. The ports of shaders.com presets live in the
// generated shaderPresetsLab.js and are appended below.
// Presets declare tweakable uniforms (colours, sizes, densities) and list them
// in `params` below. EVERY colour a preset draws is one of them, background
// included. Every default is chosen so an untouched preset renders as it did
// before parametrization — colour uniforms replace a plain 0–1 constant
// verbatim, or carry only the hue where the original constant is HDR (>1) and
// the multiplier stays in the code. Colour defaults are hex, so they match the
// original constants to within 1/255.

const SILK = `// Silk — domain-warped flowing gradient (iq/2014 noise base)
uniform vec3 uColorA; // warm sand
uniform vec3 uColorB; // deep blue
uniform vec3 uColorC; // rose
uniform vec3 uColorD; // sky blue
#define S(a,b,t) smoothstep(a,b,t)
mat2 Rot(float a){ float s=sin(a),c=cos(a); return mat2(c,-s,s,c); }
vec2 hash(vec2 p){ p=vec2(dot(p,vec2(2127.1,81.17)),dot(p,vec2(1269.5,283.37))); return fract(sin(p)*43758.5453); }
float noise(in vec2 p){
  vec2 i=floor(p), f=fract(p);
  vec2 u=f*f*(3.0-2.0*f);
  float n=mix(mix(dot(-1.0+2.0*hash(i+vec2(0.0,0.0)),f-vec2(0.0,0.0)),
                  dot(-1.0+2.0*hash(i+vec2(1.0,0.0)),f-vec2(1.0,0.0)),u.x),
              mix(dot(-1.0+2.0*hash(i+vec2(0.0,1.0)),f-vec2(0.0,1.0)),
                  dot(-1.0+2.0*hash(i+vec2(1.0,1.0)),f-vec2(1.0,1.0)),u.x),u.y);
  return 0.5+0.5*n;
}
void mainImage(out vec4 fragColor,in vec2 fragCoord){
  vec2 uv=fragCoord/iResolution.xy;
  float ratio=iResolution.x/iResolution.y;
  vec2 tuv=uv-0.5;
  float degree=noise(vec2(iTime*0.1,tuv.x*tuv.y));
  tuv.y*=1.0/ratio;
  tuv*=Rot(radians((degree-0.5)*720.0+180.0));
  tuv.y*=ratio;
  float frequency=5.0, amplitude=30.0, speed=iTime*2.0;
  tuv.x+=sin(tuv.y*frequency+speed)/amplitude;
  tuv.y+=sin(tuv.x*frequency*1.5+speed)/(amplitude*0.5);
  vec3 layer1=mix(uColorA,uColorB,S(-0.3,0.2,(tuv*Rot(radians(-5.0))).x));
  vec3 layer2=mix(uColorC,uColorD,S(-0.3,0.2,(tuv*Rot(radians(-5.0))).x));
  vec3 finalComp=mix(layer1,layer2,S(0.5,-0.3,tuv.y));
  fragColor=vec4(finalComp,1.0);
}`;


const PLASMA = `// Plasma — smooth interfering waves
uniform float uPlasmaScale; // wave density
uniform float uHueShift;    // radians around the palette
// Three stops the wave cycles through. The original was a fixed cosine palette;
// these defaults are that palette sampled at its three phase peaks, so the
// shipped look is preserved while the colours become pickable. The cycling is
// kept — the phase still advances with time and uHueShift still rotates it.
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform vec3 uColorC;
void mainImage(out vec4 o,in vec2 fc){
  vec2 uv=fc/iResolution.xy;
  float sc=uPlasmaScale>0.0?uPlasmaScale:4.0;
  vec2 p=(uv-0.5)*vec2(iResolution.x/iResolution.y,1.0)*sc;
  float t=iTime*0.6;
  float v=sin(p.x+t)+sin(p.y+t*1.3)+sin((p.x+p.y)*0.7+t*0.7);
  v+=sin(length(p)*1.5-t*1.5);
  v*=0.25;
  // Phase around the three stops, matching the cosine palette's rate.
  float ph=fract((v*3.14159+t*0.2+uHueShift)/6.2831853);
  float seg=ph*3.0;
  vec3 col = seg<1.0 ? mix(uColorA,uColorB,seg)
           : seg<2.0 ? mix(uColorB,uColorC,seg-1.0)
                     : mix(uColorC,uColorA,seg-2.0);
  o=vec4(col,1.0);
}`;


const MESH = `// Mesh gradient — four drifting color anchors (soft, no edges)
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform vec3 uColorC;
uniform vec3 uColorD;
void mainImage(out vec4 o,in vec2 fc){
  vec2 p=fc/iResolution.xy;
  p.x*=iResolution.x/iResolution.y;
  float t=iTime*0.3;
  float a=iResolution.x/iResolution.y;
  vec2 p0=vec2(0.30*a+0.20*sin(t*1.1),0.30+0.20*cos(t*0.9));
  vec2 p1=vec2(0.70*a+0.20*sin(t*0.7+2.0),0.35+0.20*cos(t*1.3+1.0));
  vec2 p2=vec2(0.40*a+0.25*sin(t*0.9+4.0),0.70+0.20*cos(t*0.8+3.0));
  vec2 p3=vec2(0.75*a+0.20*sin(t*1.2+1.5),0.75+0.25*cos(t*1.0+2.5));
  vec3 c0=uColorA;
  vec3 c1=uColorB;
  vec3 c2=uColorC;
  vec3 c3=uColorD;
  vec3 col=vec3(0.0); float w=0.0; float wi;
  wi=1.0/(0.0008+dot(p-p0,p-p0)); col+=c0*wi; w+=wi;
  wi=1.0/(0.0008+dot(p-p1,p-p1)); col+=c1*wi; w+=wi;
  wi=1.0/(0.0008+dot(p-p2,p-p2)); col+=c2*wi; w+=wi;
  wi=1.0/(0.0008+dot(p-p3,p-p3)); col+=c3*wi; w+=wi;
  o=vec4(col/w,1.0);
}`;

const WAVES = `// Warp waves — coral / magenta ribboned flow
uniform vec3 uColorHot;
uniform vec3 uColorMid;
uniform vec3 uColorDeep;
mat2 Rot(float a){ float s=sin(a),c=cos(a); return mat2(c,-s,s,c); }
void mainImage(out vec4 o,in vec2 fc){
  vec2 uv=fc/iResolution.xy;
  float ratio=iResolution.x/iResolution.y;
  vec2 tuv=uv-0.5;
  tuv.y*=1.0/ratio;
  tuv*=Rot(radians(sin(iTime*0.2)*40.0));
  tuv.y*=ratio;
  float speed=iTime*1.2;
  tuv.x+=sin(tuv.y*6.0+speed)/24.0;
  tuv.y+=sin(tuv.x*9.0+speed)/14.0;
  float m=smoothstep(-0.35,0.35,(tuv*Rot(radians(-8.0))).x);
  vec3 col=mix(uColorHot,uColorMid,m);
  col=mix(col,uColorDeep,smoothstep(0.55,-0.35,tuv.y));
  o=vec4(col,1.0);
}`;

// Positions are given relative to the half-frame and radii relative to the
// half-diagonal, so the same composition holds at 16:9, 1:1 and 9:16.
const GLOW_BLOBS = `// Glow Blobs — soft drifting colour clouds over near-black
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform vec3 uColorC;
uniform vec3 uColorD;
uniform vec3 uColorE;
uniform vec3 uBgColor;   // the near-black the blobs sit on
uniform float uBlobSize; // 1 = original radii
vec3 blob(vec2 q, vec2 c, float r, vec3 col){
  float d = length(q - c) / r;
  return col * exp(-d * d * 1.7);
}
void mainImage(out vec4 o, in vec2 fc){
  float a = iResolution.x / iResolution.y;
  vec2 q = (fc / iResolution.xy - 0.5) * vec2(a, 1.0);
  vec2 hf = vec2(a * 0.5, 0.5);
  float k = 0.5 * sqrt(a * a + 1.0) * (uBlobSize > 0.0 ? uBlobSize : 1.0);
  float t = iTime * 0.16;
  vec3 col = uBgColor;
  col += blob(q, vec2(-0.52 + 0.10 * sin(t * 0.90),        0.34 + 0.08 * cos(t * 1.10)) * hf,       0.60 * k, uColorA);
  col += blob(q, vec2( 0.50 + 0.09 * sin(t * 0.70 + 2.0),  0.40 + 0.08 * cos(t * 0.85 + 1.0)) * hf, 0.58 * k, uColorB);
  col += blob(q, vec2(-0.54 + 0.11 * sin(t * 1.20 + 4.0), -0.46 + 0.09 * cos(t * 0.95 + 3.0)) * hf, 0.62 * k, uColorC);
  col += blob(q, vec2( 0.16 + 0.12 * sin(t * 0.80 + 1.5), -0.66 + 0.08 * cos(t * 1.05 + 2.5)) * hf, 0.66 * k, uColorD);
  col += blob(q, vec2( 0.70 + 0.09 * sin(t * 1.10 + 3.4), -0.14 + 0.10 * cos(t * 0.70 + 0.5)) * hf, 0.46 * k, uColorE);
  col = col / (1.0 + col * 0.5);
  col *= mix(0.22, 1.0, smoothstep(1.25, 0.30, length(q) / k));
  o = vec4(col, 1.0);
}`;

// The two below compose against the frame the same way GLOW_BLOBS does:
// positions relative to the half-frame, radii relative to the half-diagonal `k`,
// so the arc/ridge keeps its proportions at 16:9, 1:1 and 9:16.

const BLUE_PLANET = `// Blue Planet — a dark limb lit by a thin rim and its atmosphere
uniform vec3 uTint; // white = original grade
// Every colour is pickable; defaults are the original constants. Where the
// original pushed a colour past 1.0 its multiplier stays in the code below.
uniform vec3 uNightColor;   // unlit body
uniform vec3 uSurfaceColor; // lit band across the body
uniform vec3 uRimColor;     // thin bright limb
uniform vec3 uRimHiColor;   // hottest edge of the limb
uniform vec3 uAtmoColor;    // halo outside the disc
uniform vec3 uBgColor;      // lift over the whole frame
vec3 tintOr1(vec3 t){ return dot(t, t) < 1e-6 ? vec3(1.0) : t; }
float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = h21(i), b = h21(i + vec2(1.0, 0.0)), c = h21(i + vec2(0.0, 1.0)), d = h21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float fbm(vec2 p){
  float s = 0.0, m = 0.5;
  for (int i = 0; i < 5; i++){ s += m * vnoise(p); p *= 2.03; m *= 0.5; }
  return s;
}
void mainImage(out vec4 o, in vec2 fc){
  float a = iResolution.x / iResolution.y;
  vec2 q = (fc / iResolution.xy - 0.5) * vec2(a, 1.0);
  float k = 0.5 * sqrt(a * a + 1.0);
  float t = iTime * 0.04;

  vec2 c = vec2(0.02 * k, -0.50 * k);
  float R = 0.84 * k;
  vec2 n2 = (q - c) / R;
  float r2 = dot(n2, n2);
  float d = (length(q - c) - R) / k;
  float z = sqrt(max(0.0, 1.0 - min(r2, 1.0)));
  vec3 N = vec3(n2, z);

  vec3 L = normalize(vec3(0.10 + 0.09 * sin(t * 0.7), 0.99, 0.16));
  float lam = max(dot(N, L), 0.0);

  // Fake spherical mapping so surface mottling compresses toward the limb.
  vec2 sp = n2 / (z + 0.55);
  float clouds = fbm(sp * 2.2 + vec2(t * 1.2, t * 0.15));
  clouds = mix(0.62, 1.35, smoothstep(0.35, 0.82, clouds));

  // The body reads as near-black; almost all the light lives in the limb band.
  float band = pow(lam, 3.6) * clouds;
  vec3 body = uNightColor + uSurfaceColor * band * 0.55;

  float limb = pow(1.0 - z, 5.5) * pow(lam, 1.15) * clouds;
  body += uRimColor * limb * 2.30;
  body += uRimHiColor * pow(1.0 - z, 14.0) * pow(lam, 2.0) * 0.90;

  vec3 col = body * smoothstep(0.003, -0.003, d);

  // Atmospheric halo — outside the disc only, and only on the lit side.
  float lit = max(dot(normalize(vec3(n2, 0.001)), L), 0.0);
  float atmo = (exp(-max(d, 0.0) / 0.022) * 0.55 + exp(-max(d, 0.0) / 0.09) * 0.16)
             * smoothstep(-0.004, 0.004, d);
  col += uAtmoColor * atmo * pow(lit, 1.6);

  col += uBgColor;                                        // space isn't pure black
  col *= mix(0.72, 1.0, smoothstep(1.30, 0.30, length(q) / k));

  col *= tintOr1(uTint);
  float grain = h21(fc + floor(iTime * 8.0) * 13.0) - 0.5;
  col += grain * 0.030;
  o = vec4(max(col, 0.0), 1.0);
}`;

const AURORA_RIDGE = `// Aurora Ridge — luminous fog ridge rising over a black stage
uniform vec3 uTint; // white = original grade
// Every colour is pickable; defaults are the original constants.
uniform vec3 uCrestColor; // violet fringe along the back crest
uniform vec3 uFogColor;   // lilac body of the fog
uniform vec3 uCoreColor;  // near-white heart of the fog
uniform vec3 uEdgeColor;  // blue light on the steep slopes
uniform vec3 uFrontGlow;  // glow along the front ridge
uniform vec3 uWashA;      // wash over the bottom of the fog, left to right
uniform vec3 uWashB;
uniform vec3 uWashC;
uniform vec3 uWashD;
uniform vec3 uSkyGlow;    // faint glow in the top right corner
uniform vec3 uBgColor;    // the black stage
vec3 tintOr1(vec3 t){ return dot(t, t) < 1e-6 ? vec3(1.0) : t; }
float ridge(float x, float t, float ph){
  return 0.11 * sin(x * 2.3 + t * 0.55 + ph)
       + 0.07 * sin(x * 4.1 - t * 0.41 + ph * 1.7)
       + 0.04 * sin(x * 7.7 + t * 0.83 + ph * 0.6);
}
void mainImage(out vec4 o, in vec2 fc){
  vec2 uv = fc / iResolution.xy;
  float a = iResolution.x / iResolution.y;
  float t = iTime * 0.35;
  float x = (uv.x - 0.5) * a;

  vec3 col = uBgColor;
  col += uSkyGlow * exp(-length((uv - vec2(0.88, 0.92)) * vec2(a, 1.0)) / 0.30);

  vec3 violet = uCrestColor;
  vec3 white  = uCoreColor;
  vec3 lilac  = uFogColor;
  vec3 blue   = uEdgeColor;

  // ── Back ridge — the tall crest carrying the violet fringe.
  float h1 = 0.54 + ridge(x, t, 0.0);
  float s1 = h1 - uv.y;                                    // >0 below the crest
  float e = 0.004;
  float slope1 = (ridge(x + e, t, 0.0) - ridge(x - e, t, 0.0)) / (2.0 * e * a);

  vec3 c1 = mix(violet, lilac, smoothstep(0.015, 0.14, s1));
  c1 = mix(c1, white, smoothstep(0.09, 0.30, s1));
  float m1 = smoothstep(-0.045, 0.060, s1);
  col = mix(col, c1, m1);
  col += violet * exp(-abs(s1 - 0.008) / 0.040) * 0.55;
  col += blue * exp(-abs(s1 + 0.008) / 0.018) * clamp(abs(slope1) * 0.8, 0.0, 1.0) * 0.80;

  // ── Front ridge — the softer bank of fog overlapping it.
  float h2 = 0.34 + 0.75 * ridge(x * 0.8 + 1.7, t * 0.8, 2.4);
  float s2 = h2 - uv.y;
  vec3 c2 = mix(mix(lilac, white, 0.45), white, smoothstep(0.02, 0.22, s2));
  float m2 = smoothstep(-0.070, 0.080, s2);
  col = mix(col, c2, m2 * 0.90);
  col += uFrontGlow * exp(-abs(s2) / 0.048) * 0.26;

  // Colour wash picked up by the fog toward the bottom of the frame:
  // periwinkle at the left, violet, then pink and warm white at the right.
  vec3 tint = mix(uWashA, uWashB, smoothstep(0.02, 0.28, uv.x));
  tint = mix(tint, uWashC, smoothstep(0.28, 0.54, uv.x));
  tint = mix(tint, uWashD, smoothstep(0.54, 0.86, uv.x));
  float body = max(m1, m2);
  col = mix(col, tint * 1.12, smoothstep(0.32, 0.00, uv.y) * body * 0.62);

  // Bright core in the belly of the fog, just under the crest.
  col += white * 0.30 * body
       * exp(-length((uv - vec2(0.60, 0.26)) * vec2(a * 0.75, 1.35)) / 0.34);

  col *= mix(0.88, 1.0, smoothstep(1.0, 0.20, abs(uv.x - 0.5) * 2.0));
  col = col / (1.0 + col * 0.14);
  col *= tintOr1(uTint);
  o = vec4(max(col, 0.0), 1.0);
}`;

// The four below are one family, matched frame-by-frame off a SaaS title
// sequence (prototype: html/shader-backgrounds-saas.html, which embeds the
// reference stills and the numeric fit). Same composition rule as GLOW_BLOBS:
// centres in half-frame units, radii in half-diagonals, so they hold at 16:9,
// 1:1 and 9:16. All end with a static dither — these are very large flat
// gradients and they band badly on 8-bit without it.

const EMBER_POOL = `// Ember Pool — warm footlight rising into a black room
uniform vec3 uTint; // white = original grade
// The four sources are pickable. Each uniform carries only the HUE — the
// brightness stays as the literal multiplier below, because these are HDR
// values (up to 2.2) and a colour picker can only express 0..1. Defaults are
// the original colours normalised, so the shipped look is unchanged.
uniform vec3 uGlowA; // violet, from above
uniform vec3 uGlowB; // amber, from the lower left
uniform vec3 uGlowC; // rose, bridging down the left edge
uniform vec3 uGlowD; // warm bounce, right of the amber
uniform vec3 uBgColor; // the dark room
vec3 tintOr1(vec3 t){ return dot(t, t) < 1e-6 ? vec3(1.0) : t; }
vec3 pool(vec2 q, vec2 c, vec2 r, vec3 col){
  vec2 d = (q - c) / r;
  return col * exp(-dot(d, d) * 1.75);
}
void mainImage(out vec4 o, in vec2 fc){
  float a = iResolution.x / iResolution.y;
  vec2 uv = fc / iResolution.xy;
  vec2 q = (uv - 0.5) * vec2(a, 1.0);
  vec2 hf = vec2(a * 0.5, 0.5);
  float k = 0.5 * sqrt(a * a + 1.0);
  float t = iTime * 0.12;

  vec3 col = uBgColor;
  // Two opposing sources with a black band between them — sampling the reference
  // frame shows violet spilling DOWN from above and amber coming UP from the
  // lower left, not one glow at the bottom.
  col += pool(q, vec2(-0.06 + 0.22 * sin(t * 0.60),        1.16 + 0.06 * sin(t * 0.90)) * hf, vec2(0.98, 0.56) * k, uGlowA * 2.05);
  col += pool(q, vec2(-0.50 + 0.16 * sin(t * 0.85 + 1.1), -1.02 + 0.06 * cos(t * 1.20)) * hf, vec2(0.68, 0.46) * k, uGlowB * 2.20);
  // Rose bridging the two down the left edge.
  col += pool(q, vec2(-1.06, -0.18 + 0.16 * sin(t * 0.70)) * hf, vec2(0.44, 0.56) * k, uGlowC * 1.15);
  // Faint warm bounce to the right of the amber, so the floor isn't symmetric.
  col += pool(q, vec2( 0.44 + 0.12 * cos(t * 0.75), -1.10) * hf, vec2(0.52, 0.34) * k, uGlowD * 0.70);

  col = col / (1.0 + col * 0.55);
  col *= tintOr1(uTint);
  col += (fract(sin(dot(fc, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) * 0.014;
  o = vec4(max(col, 0.0), 1.0);
}`;

const NEON_VIGNETTE = `// Neon Vignette — rose and violet banked against the edges around a dark core
uniform vec3 uTint; // white = original grade
// The banked colours, pickable. Hue only — the multipliers below carry the HDR
// intensity a 0..1 picker cannot. Defaults are the originals normalised, so the
// shipped look is unchanged.
uniform vec3 uGlowA; // rose bank
uniform vec3 uGlowB; // violet bank
uniform vec3 uGlowC; // faint violet fill
uniform vec3 uBgColor; // the dark core
vec3 tintOr1(vec3 t){ return dot(t, t) < 1e-6 ? vec3(1.0) : t; }
vec3 pool(vec2 q, vec2 c, vec2 r, vec3 col){
  vec2 d = (q - c) / r;
  return col * exp(-dot(d, d) * 1.70);
}
void mainImage(out vec4 o, in vec2 fc){
  float a = iResolution.x / iResolution.y;
  vec2 uv = fc / iResolution.xy;
  vec2 q = (uv - 0.5) * vec2(a, 1.0);
  vec2 hf = vec2(a * 0.5, 0.5);
  float k = 0.5 * sqrt(a * a + 1.0);
  float t = iTime * 0.10;

  vec3 col = uBgColor;
  // Rose in both bottom corners with violet between them, pushed hard into the
  // side edges so the perimeter carries the light.
  col += pool(q, vec2(-1.06 + 0.10 * sin(t * 0.80),       -0.86 + 0.05 * sin(t * 1.10)) * hf, vec2(0.56, 0.52) * k, uGlowA * 2.10);
  col += pool(q, vec2( 0.00 + 0.20 * sin(t * 0.55 + 2.4), -1.04 + 0.08 * cos(t * 0.90 + 1.1)) * hf, vec2(0.70, 0.50) * k, uGlowB * 2.05);
  col += pool(q, vec2( 1.10 + 0.10 * cos(t * 0.95), -0.82 + 0.06 * sin(t * 0.70)) * hf, vec2(0.54, 0.52) * k, uGlowA * 2.20);
  // Violet spill down both upper edges — the outermost of the concentric layers.
  col += pool(q, vec2(-1.15, 0.55 + 0.12 * sin(t * 0.70)) * hf, vec2(0.46, 0.62) * k, uGlowC * 0.80);
  col += pool(q, vec2( 1.18, 0.62 + 0.10 * cos(t * 0.60)) * hf, vec2(0.44, 0.60) * k, uGlowC * 0.74);

  // Concentric dark core — a GAIN that reaches 1.0 at the perimeter, not a
  // subtracted blob (subtracting dims the whole frame). Two nested bands so the
  // falloff reads as stacked layers rather than one soft hole.
  vec2 hc = vec2(0.04 + 0.30 * sin(t * 0.45 + 1.2), 0.02 + 0.16 * cos(t * 0.65)) * hf;
  float rr = length((q - hc) / (vec2(1.15, 0.95) * k));
  float vig = mix(0.68, 1.0, smoothstep(0.15, 1.35, rr))
            * mix(0.90, 1.0, smoothstep(0.60, 1.90, rr));
  // Released at the bottom edge, which the reference keeps fully saturated.
  col *= mix(1.0, vig, smoothstep(0.02, 0.34, uv.y));
  // Outer rim lift — the third layer, and what makes the banding read.
  col *= 1.0 + 0.12 * smoothstep(1.20, 2.00, rr);

  col = col / (1.0 + col * 0.55);
  col *= mix(1.0, 0.10, smoothstep(0.30, 0.94, uv.y));
  col *= tintOr1(uTint);
  col += (fract(sin(dot(fc, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) * 0.014;
  o = vec4(max(col, 0.0), 1.0);
}`;

const ELECTRIC_VIGNETTE = `// Electric Vignette — saturated blue banked against the edges, dark core
uniform vec3 uTint; // white = original grade
// The banked colour, pickable. Hue only — the 1.06 multiplier below keeps the
// original HDR intensity, which a 0..1 picker cannot carry.
uniform vec3 uGlowA;
uniform vec3 uBgColor; // the dark core
vec3 tintOr1(vec3 t){ return dot(t, t) < 1e-6 ? vec3(1.0) : t; }
void mainImage(out vec4 o, in vec2 fc){
  float a = iResolution.x / iResolution.y;
  vec2 uv = fc / iResolution.xy;
  vec2 q = (uv - 0.5) * vec2(a, 1.0);
  vec2 hf = vec2(a * 0.5, 0.5);
  float k = 0.5 * sqrt(a * a + 1.0);
  float t = iTime * 0.11;

  // Sampling the reference shows this one is almost purely VERTICAL — the bottom
  // rows are flat across the full width — so it is a height falloff with a slow
  // wobble, not a corner blob like its siblings.
  float h = uv.y
          + 0.055 * sin(uv.x * 3.1 + t * 0.90)
          + 0.035 * sin(uv.x * 1.7 - t * 0.60 + 1.4);
  h = max(h, 0.0);

  vec3 col = uBgColor;
  // Super-gaussian, NOT a plain exponential: the reference's edge column is a
  // flat plateau over the lower third and then a fast shoulder. A decaying
  // exponential fitted to the bottom row lands ~50% too dark through the middle.
  // Fitted against the LEFT EDGE column, because that is where the vignette
  // gain below is 1.0. Green stays near zero — that is what keeps the blue
  // reading electric rather than periwinkle.
  //
  // Amplitude is deliberately BELOW the reference (which clips to #3b00f2 across
  // the whole bottom edge): held there the foot reads as a solid slab, so it is
  // pulled back to leave the bottom short of saturation.
  col += uGlowA * 1.06 * exp(-pow(h / 0.66, 3.9));

  // Concentric dark core. The reference's horizontal profile at mid-height is a
  // U — bright at BOTH side edges, ~30% down through the middle — so the flood
  // is banked against the frame edges by a drifting elliptical hole.
  //
  // Written as a GAIN that reaches exactly 1.0 at the perimeter rather than a
  // subtracted blob: subtracting dims the whole frame (it cost ~40% of the
  // overall level and blew the fit), this only carves the middle out.
  // Two nested bands, so the falloff reads as stacked layers.
  // The ellipse has to be small enough that the frame's side edges fall OUTSIDE
  // it, or the "bright edge" the whole look depends on gets dimmed too.
  vec2 hc = vec2(0.10 + 0.34 * sin(t * 0.50), 0.00 + 0.16 * cos(t * 0.70)) * hf;
  float rr = length((q - hc) / (vec2(0.75, 0.65) * k));
  // The core also deepens toward the top, as it does in the reference.
  float dep = mix(0.74, 0.58, smoothstep(0.35, 0.85, uv.y));
  float vig = mix(dep, 1.0, smoothstep(0.15, 1.35, rr))
            * mix(0.92, 1.0, smoothstep(0.60, 1.90, rr));
  // Released at the bottom edge, which the reference keeps fully saturated.
  col *= mix(1.0, vig, smoothstep(0.02, 0.32, uv.y));
  // Outer rim lift — the third layer, and what makes the banding read.
  col *= 1.0 + 0.10 * smoothstep(1.30, 2.20, rr);

  col = col / (1.0 + col * 0.42);
  col *= tintOr1(uTint);
  col += (fract(sin(dot(fc, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) * 0.014;
  o = vec4(max(col, 0.0), 1.0);
}`;

const SPECTRUM_DRIFT = `// Spectrum Drift — the same footlights cycling amber -> rose -> violet -> blue
// The four stops it cycles through, pickable. Defaults are the original ramp.
uniform vec3 uTint; // white = original grade
uniform vec3 uGlowA;
uniform vec3 uGlowB;
uniform vec3 uGlowC;
uniform vec3 uGlowD;
uniform vec3 uBgColor; // the dark room
vec3 tintOr1(vec3 t){ return dot(t, t) < 1e-6 ? vec3(1.0) : t; }
vec3 pool(vec2 q, vec2 c, vec2 r, vec3 col){
  vec2 d = (q - c) / r;
  return col * exp(-dot(d, d) * 1.70);
}
// Seamless four-stop loop through the palette the reference moves along.
vec3 hueRamp(float p){
  p = fract(p);
  vec3 c0 = uGlowA * 1.00;
  vec3 c1 = uGlowB * 0.95;
  vec3 c2 = uGlowC * 0.98;
  vec3 c3 = uGlowD * 1.00;
  float s = p * 4.0;
  vec3 c = mix(c0, c1, smoothstep(0.0, 1.0, clamp(s,       0.0, 1.0)));
  c = mix(c, c2, smoothstep(0.0, 1.0, clamp(s - 1.0, 0.0, 1.0)));
  c = mix(c, c3, smoothstep(0.0, 1.0, clamp(s - 2.0, 0.0, 1.0)));
  c = mix(c, c0, smoothstep(0.0, 1.0, clamp(s - 3.0, 0.0, 1.0)));
  return c;
}
void mainImage(out vec4 o, in vec2 fc){
  float a = iResolution.x / iResolution.y;
  vec2 uv = fc / iResolution.xy;
  vec2 q = (uv - 0.5) * vec2(a, 1.0);
  vec2 hf = vec2(a * 0.5, 0.5);
  float k = 0.5 * sqrt(a * a + 1.0);
  float t = iTime * 0.11;
  float cyc = iTime * 0.035;   // ~28s round trip through the palette

  vec3 col = uBgColor;
  col += pool(q, vec2(-0.34 + 0.20 * sin(t * 0.80),       -0.90 + 0.06 * sin(t * 1.10)) * hf, vec2(0.76, 0.50) * k, hueRamp(cyc) * 1.65);
  col += pool(q, vec2( 0.52 + 0.20 * sin(t * 0.55 + 2.4), -0.84 + 0.08 * cos(t * 0.90)) * hf, vec2(0.62, 0.54) * k, hueRamp(cyc + 0.28) * 1.35);
  col += pool(q, vec2( 0.94 + 0.10 * cos(t * 0.65 + 0.6), -0.05 + 0.14 * sin(t * 0.75)) * hf, vec2(0.46, 0.64) * k, hueRamp(cyc + 0.58) * 0.60);
  col += pool(q, vec2(-0.96, 0.90) * hf, vec2(0.52, 0.52) * k, hueRamp(cyc + 0.75) * 0.30);

  col = col / (1.0 + col * 0.55);
  col *= mix(1.0, 0.09, smoothstep(0.25, 0.90, uv.y));
  col *= tintOr1(uTint);
  col += (fract(sin(dot(fc, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) * 0.014;
  o = vec4(max(col, 0.0), 1.0);
}`;

const FIRE = `// Fire — flames, drifting sparks and smoke.
// Port of "Sparks drifting" by Sjeiti (https://www.shadertoy.com/view/MlKSWm),
// simplex noise by Ian McEwan / Ashima Arts (MIT). Coordinates are normalized
// to a virtual 640px-wide frame so the flame reads identically at any
// resolution (the original works in raw pixels and dissolves at 1080p+).
uniform vec3 uFlameTint;    // multiplies the flame ramp; white = original
uniform vec3 uFlameOuter;   // the ramp the flame heats through: outer edge,
uniform vec3 uFlameMid;     // its middle,
uniform vec3 uFlameCore;    // and the hottest core (original red, yellow, white)
uniform vec3 uSparkColor;   // spark colour; original is vec3(1.0, 0.3, 0.0)
uniform vec3 uSmokeColor;   // white = original grey smoke
uniform vec3 uBgColor;      // under everything; black = original
uniform float uFlameHeight; // 1 = original proportions
uniform float uSparkAmount; // spark size/intensity; 0 disables them
uniform float uSmokeAmount; // smoke level; 1 = original
vec3 tintOr1(vec3 t){ return dot(t, t) < 1e-6 ? vec3(1.0) : t; }
vec3 mod289(vec3 x){ return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x){ return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x){ return mod289(((x * 34.0) + 1.0) * x); }
float snoise(vec3 v){
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
      i.z + vec4(0.0, i1.z, i2.z, 1.0))
    + i.y + vec4(0.0, i1.y, i2.y, 1.0))
    + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = inversesqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
float prng(in vec2 seed){
  seed = fract(seed * vec2(5.3983, 5.4427));
  seed += dot(seed.yx, seed.xy + vec2(21.5351, 14.3137));
  return fract(seed.x * seed.y * 95.4337);
}
const float PI = 3.14159265358979;
float noiseStack(vec3 pos, int octaves, float falloff){
  float noise = snoise(vec3(pos));
  float off = 1.0;
  if (octaves > 1) { pos *= 2.0; off *= falloff; noise = (1.0 - off) * noise + off * snoise(vec3(pos)); }
  if (octaves > 2) { pos *= 2.0; off *= falloff; noise = (1.0 - off) * noise + off * snoise(vec3(pos)); }
  if (octaves > 3) { pos *= 2.0; off *= falloff; noise = (1.0 - off) * noise + off * snoise(vec3(pos)); }
  return (1.0 + noise) / 2.0;
}
vec2 noiseStackUV(vec3 pos, int octaves, float falloff, float diff){
  float displaceA = noiseStack(pos, octaves, falloff);
  float displaceB = noiseStack(pos + vec3(3984.293, 423.21, 5235.19), octaves, falloff);
  return vec2(displaceA, displaceB);
}
void mainImage(out vec4 fragColor, in vec2 fragCoord){
  // Virtual 640-wide frame: all the pixel-unit constants below were tuned there.
  float vscale = 640.0 / iResolution.x;
  vec2 fc = fragCoord * vscale;
  vec2 resolution = iResolution.xy * vscale;
  float time = iTime;
  float xpart = fc.x / resolution.x;
  float ypart = fc.y / resolution.y;
  float flameH = uFlameHeight > 0.0 ? uFlameHeight : 1.0;
  float clip = 210.0 * flameH * (resolution.y / 360.0);
  float ypartClip = fc.y / clip;
  float ypartClippedFalloff = clamp(2.0 - ypartClip, 0.0, 1.0);
  float ypartClipped = min(ypartClip, 1.0);
  float ypartClippedn = 1.0 - ypartClipped;
  float xfuel = 1.0 - abs(2.0 * xpart - 1.0);
  float realTime = 0.5 * time;
  vec2 coordScaled = 0.01 * fc;
  vec3 position = vec3(coordScaled, 0.0) + vec3(1223.0, 6434.0, 8425.0);
  vec3 flow = vec3(4.1 * (0.5 - xpart) * pow(ypartClippedn, 4.0), -2.0 * xfuel * pow(ypartClippedn, 64.0), 0.0);
  vec3 timing = realTime * vec3(0.0, -1.7, 1.1) + flow;
  vec3 displacePos = vec3(1.0, 0.5, 1.0) * 2.4 * position + realTime * vec3(0.01, -0.7, 1.3);
  vec3 displace3 = vec3(noiseStackUV(displacePos, 2, 0.4, 0.1), 0.0);
  vec3 noiseCoord = (vec3(2.0, 1.0, 1.0) * position + timing + 0.4 * displace3) / 1.0;
  float noise = noiseStack(noiseCoord, 3, 0.4);
  float flames = pow(ypartClipped, 0.3 * xfuel) * pow(noise, 0.3 * xfuel);
  float f = ypartClippedFalloff * pow(1.0 - flames * flames * flames, 8.0);
  float fff = f * f * f;
  // The original ramp is vec3(f, f^3, f^9). Split into three colours weighted
  // f - f^3, f^3 - f^9 and f^9, it is the same ramp exactly when they are red,
  // yellow and white, and every weight stays >= 0 because f is in 0..1.
  vec3 ramp = uFlameOuter * (f - fff) + uFlameMid * (fff - fff * fff) + uFlameCore * (fff * fff);
  vec3 fire = 1.5 * ramp * tintOr1(uFlameTint);
  // smoke
  float smokeNoise = 0.5 + snoise(0.4 * position + timing * vec3(1.0, 1.0, 0.2)) / 2.0;
  vec3 smoke = uSmokeAmount * vec3(0.3 * pow(xfuel, 3.0) * pow(ypart, 2.0) * (smokeNoise + 0.4 * (1.0 - noise))) * uSmokeColor;
  // sparks
  float sparkGridSize = 30.0;
  vec2 sparkCoord = fc - vec2(0.0, 190.0 * realTime);
  sparkCoord -= 30.0 * noiseStackUV(0.01 * vec3(sparkCoord, 30.0 * time), 1, 0.4, 0.1);
  sparkCoord += 100.0 * flow.xy;
  if (mod(sparkCoord.y / sparkGridSize, 2.0) < 1.0) sparkCoord.x += 0.5 * sparkGridSize;
  vec2 sparkGridIndex = vec2(floor(sparkCoord / sparkGridSize));
  float sparkRandom = prng(sparkGridIndex);
  float sparkLife = min(10.0 * (1.0 - min((sparkGridIndex.y + (190.0 * realTime / sparkGridSize)) / (24.0 - 20.0 * sparkRandom), 1.0)), 1.0);
  vec3 sparks = vec3(0.0);
  if (sparkLife > 0.0 && uSparkAmount > 0.0) {
    float sparkSize = xfuel * xfuel * sparkRandom * 0.08 * uSparkAmount;
    float sparkRadians = 999.0 * sparkRandom * 2.0 * PI + 2.0 * time;
    vec2 sparkCircular = vec2(sin(sparkRadians), cos(sparkRadians));
    vec2 sparkOffset = (0.5 - sparkSize) * sparkGridSize * sparkCircular;
    vec2 sparkModulus = mod(sparkCoord + sparkOffset, sparkGridSize) - 0.5 * vec2(sparkGridSize);
    float sparkLength = length(sparkModulus);
    float sparksGray = max(0.0, 1.0 - sparkLength / (sparkSize * sparkGridSize));
    sparks = sparkLife * sparksGray * tintOr1(uSparkColor);
  }
  fragColor = vec4(uBgColor + max(fire, sparks) + smoke, 1.0);
}`;

const SPACE_TRAVEL = `// Space Travel — radial starfield warp.
// Port of "Starfield Math" (https://www.shadertoy.com/view/XtBSWt) with
// resolution-relative star size (the original draws ~1px stars that vanish at
// 1080p) and a size floor so distant dust stays visible.
uniform vec3 uStarColor;  // white = original
uniform float uStarSize;  // star radius as % of frame height
uniform float uStarCount; // active stars, up to 400
uniform vec3 uBgColor;    // space; black = original
vec3 tintOr1(vec3 t){ return dot(t, t) < 1e-6 ? vec3(1.0) : t; }
vec2 polar(vec2 p){ return vec2(length(p), atan(p.y, p.x)); }
float rand(vec2 co){ return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453); }
vec2 decart(vec2 p){ return vec2(p.x * cos(p.y), p.x * sin(p.y)); }
void mainImage(out vec4 fragColor, in vec2 fragCoord){
  vec2 center = iResolution.xy / 2.0;
  vec2 frag = fragCoord - center;
  vec2 fragPolar = polar(frag);
  float lenCenter = length(center);
  const float bandPass = 720.0;
  const float angleDisp = 6.28318530718 / (bandPass + 1.0);
  float count = clamp(uStarCount > 0.0 ? uStarCount : 200.0, 1.0, 400.0);
  float starPx = max(1.0, (uStarSize > 0.0 ? uStarSize : 2.5) * 0.01 * iResolution.y);
  float globTime = iTime / 10.0; // 10s particle lifetime
  const float polarRadiusClip = 0.05;
  const float polarRadiusDelta = 0.75 - polarRadiusClip;
  float presence = 0.0;
  vec2 pPoint;
  for (float i = 0.0; i < 400.0; i += 1.0) {
    if (i >= count) break;
    float phase = i / count;
    float localTime = globTime + bandPass * (2.0 * phase - 1.0) + phase;
    float particleTime = fract(localTime);
    float spaceTransform = pow(particleTime, 8.0); // rushes outward at end of life
    pPoint.x = lenCenter * ((polarRadiusClip + polarRadiusDelta * phase) + spaceTransform);
    float particleSize = starPx * (0.2 + 0.8 * spaceTransform);
    if (abs(pPoint.x - fragPolar.x) > particleSize) continue;
    pPoint.y = floor(particleTime + bandPass * rand(vec2(floor(localTime), 1.0))) * angleDisp;
    vec2 dPoint = decart(pPoint);
    float s = 1.0 - clamp(length(dPoint - frag) / particleSize, 0.0, 1.0);
    presence += s * s * clamp(0.15 + spaceTransform * 20.0, 0.0, 1.0);
  }
  presence = clamp(presence, 0.0, 1.0);
  fragColor = vec4(uBgColor + tintOr1(uStarColor) * presence, 1.0);
}`;

const GLITTERS = `// Glitter Dust — sparse twinkling points drifting upward.
// Inspired by "Simple magic glitters" (https://www.shadertoy.com/view/XtVBWV);
// the noise-texture (iChannel0) lookups are replaced with procedural value
// noise so it runs textureless, and density/size are tweakable.
uniform vec3 uGlitterColor;  // white = original
uniform float uGlitterSize;  // 1 = original grain; bigger = larger grains
uniform float uSparsity;     // higher = fewer points (original ~15)
uniform vec3 uBgColor;       // black = original
vec3 tintOr1(vec3 t){ return dot(t, t) < 1e-6 ? vec3(1.0) : t; }
float gh(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float gnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(gh(i), gh(i + vec2(1.0, 0.0)), f.x),
             mix(gh(i + vec2(0.0, 1.0)), gh(i + vec2(1.0, 1.0)), f.x), f.y);
}
void mainImage(out vec4 fragColor, in vec2 fragCoord){
  vec2 uv = fragCoord / iResolution.x;
  vec2 uv2 = uv;
  uv.y += iTime / 10.0;
  uv.x -= sin(iTime / 10.0) / 2.0;
  uv2.y += iTime / 14.0;
  uv2.x += sin(iTime / 10.0) / 9.0;
  float size = uGlitterSize > 0.0 ? uGlitterSize : 1.0;
  // The original samples a 256px noise texture at uv*0.6 / uv2*0.9 — that is
  // ~154 noise cells across the frame width; size scales the cells up.
  float freq = 154.0 / size;
  float n1 = gnoise((uv * 0.6 + vec2(iTime * -0.003)) * freq);
  float n2 = gnoise((uv2 * 0.9 + vec2(iTime * 0.002)) * freq);
  float ex = uSparsity > 0.0 ? uSparsity : 15.0;
  float result = pow(clamp(n1 * n2, 0.0, 1.0), ex);
  fragColor = vec4(uBgColor + tintOr1(uGlitterColor) * 18.0 * result, 1.0);
}`;

export const SHADER_PRESETS = [
  { id: 'silk', name: 'Silk Flow', code: SILK, params: [
    { key: 'uColorA', label: 'Color 1', type: 'color', default: '#f4cd9f' },
    { key: 'uColorB', label: 'Color 2', type: 'color', default: '#3162ee' },
    { key: 'uColorC', label: 'Color 3', type: 'color', default: '#e882cc' },
    { key: 'uColorD', label: 'Color 4', type: 'color', default: '#59b5f3' },
  ], looks: [
    { id: 'dawn', name: 'Dawn', values: { uColorA: '#f4cd9f', uColorB: '#3162ee', uColorC: '#e882cc', uColorD: '#59b5f3' } },
    { id: 'sorbet', name: 'Sorbet', values: { uColorA: '#ffd9c4', uColorB: '#b7a4f2', uColorC: '#ffb8d2', uColorD: '#a6e3d6' } },
    { id: 'graphite', name: 'Graphite', values: { uColorA: '#e4e4e1', uColorB: '#2a2c31', uColorC: '#9c9ea4', uColorD: '#5c5f66' } },
    { id: 'lagoon', name: 'Lagoon', values: { uColorA: '#c9f2e6', uColorB: '#0c4a6e', uColorC: '#2fb4ae', uColorD: '#1d7fb6' } },
    { id: 'sunset', name: 'Sunset', values: { uColorA: '#ffd27d', uColorB: '#b8336a', uColorC: '#ff8f66', uColorD: '#6b2d86' } },
    { id: 'sage', name: 'Sage', values: { uColorA: '#ece6cf', uColorB: '#3e5c46', uColorC: '#b0c49e', uColorD: '#6e8e73' } },
  ] },
  { id: 'glowblobs', name: 'Glow Blobs', code: GLOW_BLOBS, params: [
    { key: 'uColorA', label: 'Blob 1', type: 'color', default: '#2159ff' },
    { key: 'uColorB', label: 'Blob 2', type: 'color', default: '#7838ff' },
    { key: 'uColorC', label: 'Blob 3', type: 'color', default: '#ff298c' },
    { key: 'uColorD', label: 'Blob 4', type: 'color', default: '#ff6b14' },
    { key: 'uColorE', label: 'Blob 5', type: 'color', default: '#fa38b3' },
    { key: 'uBgColor', label: 'Background', type: 'color', default: '#040406' },
    { key: 'uBlobSize', label: 'Blob size', type: 'range', default: 1, min: 0.4, max: 2.5, step: 0.05 },
  ], looks: [
    { id: 'neon', name: 'Neon', values: { uColorA: '#2159ff', uColorB: '#7838ff', uColorC: '#ff298c', uColorD: '#ff6b14', uColorE: '#fa38b3', uBgColor: '#040406' } },
    { id: 'ocean', name: 'Ocean', values: { uColorA: '#0a5cff', uColorB: '#00a8c6', uColorC: '#1e3ca8', uColorD: '#19d3b4', uColorE: '#3a7bd5', uBgColor: '#02060a' } },
    { id: 'sunset', name: 'Sunset', values: { uColorA: '#ff6a3d', uColorB: '#ff2e63', uColorC: '#ffae42', uColorD: '#c2185b', uColorE: '#ff8c42', uBgColor: '#070304' } },
    { id: 'aurora', name: 'Aurora', values: { uColorA: '#16d99a', uColorB: '#6a3cff', uColorC: '#00a88a', uColorD: '#2d8fdb', uColorE: '#9b5cff', uBgColor: '#020508' } },
    { id: 'champagne', name: 'Champagne', values: { uColorA: '#a8682c', uColorB: '#d6a052', uColorC: '#7a4422', uColorD: '#e8c07a', uColorE: '#9a5c2e', uBgColor: '#060403' } },
    { id: 'silver', name: 'Silver', values: { uColorA: '#5d6878', uColorB: '#8f96a3', uColorC: '#3d4450', uColorD: '#a8aeb8', uColorE: '#727c8c', uBgColor: '#050607' } },
  ] },
  { id: 'waves', name: 'Coral Waves', code: WAVES, params: [
    { key: 'uColorHot', label: 'Highlight', type: 'color', default: '#ffd463' },
    { key: 'uColorMid', label: 'Mid tone', type: 'color', default: '#fa596b' },
    { key: 'uColorDeep', label: 'Shadow', type: 'color', default: '#85178c' },
  ], looks: [
    { id: 'coral', name: 'Coral', values: { uColorHot: '#ffd463', uColorMid: '#fa596b', uColorDeep: '#85178c' } },
    { id: 'lagoon', name: 'Lagoon', values: { uColorHot: '#a3f0df', uColorMid: '#1e9fb6', uColorDeep: '#0d3a63' } },
    { id: 'dusk', name: 'Dusk', values: { uColorHot: '#ffc8a6', uColorMid: '#b25a9c', uColorDeep: '#2c1a4d' } },
    { id: 'sage', name: 'Sage', values: { uColorHot: '#e8eed2', uColorMid: '#8fb18b', uColorDeep: '#2e4d3a' } },
    { id: 'graphite', name: 'Graphite', values: { uColorHot: '#ebebea', uColorMid: '#8b8e94', uColorDeep: '#25272c' } },
    { id: 'amber', name: 'Amber', values: { uColorHot: '#fff0c6', uColorMid: '#dba65a', uColorDeep: '#6a3d1c' } },
  ] },
  { id: 'plasma', name: 'Plasma', code: PLASMA, params: [
    { key: 'uPlasmaScale', label: 'Wave density', type: 'range', default: 4, min: 1, max: 10, step: 0.5 },
    { key: 'uHueShift', label: 'Hue shift', type: 'range', default: 0, min: 0, max: 6.28, step: 0.02 },
    // Defaults are the original cosine palette sampled at its three peaks.
    { key: 'uColorA', label: 'Color 1', type: 'color', default: '#ff8080' },
    { key: 'uColorB', label: 'Color 2', type: 'color', default: '#80ff9a' },
    { key: 'uColorC', label: 'Color 3', type: 'color', default: '#9a80ff' },
  ], looks: [
    { id: 'prism', name: 'Prism', values: { uColorA: '#ff8080', uColorB: '#80ff9a', uColorC: '#9a80ff' } },
    { id: 'lagoon', name: 'Lagoon', values: { uColorA: '#1fb5a8', uColorB: '#2563eb', uColorC: '#8fd8fb' } },
    { id: 'sunset', name: 'Sunset', values: { uColorA: '#ff7a59', uColorB: '#ffc260', uColorC: '#d6488a' } },
    { id: 'chrome', name: 'Chrome', values: { uColorA: '#2b2d31', uColorB: '#a0a4ab', uColorC: '#eceef0' } },
    { id: 'sorbet', name: 'Sorbet', values: { uColorA: '#ffc6d8', uColorB: '#c6f0e2', uColorC: '#d6c9ff' } },
    { id: 'ultraviolet', name: 'Ultraviolet', values: { uColorA: '#3c0ca8', uColorB: '#c42ad6', uColorC: '#2a5df0' } },
  ] },
  { id: 'mesh', name: 'Mesh Gradient', code: MESH, params: [
    { key: 'uColorA', label: 'Color 1', type: 'color', default: '#fcd466' },
    { key: 'uColorB', label: 'Color 2', type: 'color', default: '#f25973' },
    { key: 'uColorC', label: 'Color 3', type: 'color', default: '#734dd9' },
    { key: 'uColorD', label: 'Color 4', type: 'color', default: '#4dbff2' },
  ], looks: [
    { id: 'pop', name: 'Pop', values: { uColorA: '#fcd466', uColorB: '#f25973', uColorC: '#734dd9', uColorD: '#4dbff2' } },
    { id: 'peach', name: 'Peach', values: { uColorA: '#ffc89e', uColorB: '#ff8f87', uColorC: '#d4789a', uColorD: '#fff1df' } },
    { id: 'ocean', name: 'Ocean', values: { uColorA: '#0f4c75', uColorB: '#3282b8', uColorC: '#1b9aaa', uColorD: '#bde2fa' } },
    { id: 'sunset', name: 'Sunset', values: { uColorA: '#ffb347', uColorB: '#ff6f61', uColorC: '#c94b7c', uColorD: '#6a4c93' } },
    { id: 'forest', name: 'Forest', values: { uColorA: '#2d4a3e', uColorB: '#6b8f71', uColorC: '#a3b18a', uColorD: '#dad7cd' } },
    { id: 'graphite', name: 'Graphite', values: { uColorA: '#1f2023', uColorB: '#4b4e54', uColorC: '#8e9197', uColorD: '#dadcdf' } },
  ] },
  { id: 'fire', name: 'Fire', code: FIRE, params: [
    { key: 'uFlameTint', label: 'Flame tint', type: 'color', default: '#ffffff' },
    { key: 'uFlameOuter', label: 'Flame edge', type: 'color', default: '#ff0000' },
    { key: 'uFlameMid', label: 'Flame mid', type: 'color', default: '#ffff00' },
    { key: 'uFlameCore', label: 'Flame core', type: 'color', default: '#ffffff' },
    { key: 'uSparkColor', label: 'Spark color', type: 'color', default: '#ff4d00' },
    { key: 'uSmokeColor', label: 'Smoke color', type: 'color', default: '#ffffff' },
    { key: 'uBgColor', label: 'Background', type: 'color', default: '#000000' },
    { key: 'uFlameHeight', label: 'Flame height', type: 'range', default: 1, min: 0.3, max: 2.5, step: 0.05 },
    { key: 'uSparkAmount', label: 'Sparks', type: 'range', default: 1, min: 0, max: 2, step: 0.05 },
    { key: 'uSmokeAmount', label: 'Smoke', type: 'range', default: 1, min: 0, max: 2, step: 0.05 },
  ], looks: [
    { id: 'campfire', name: 'Campfire', values: { uFlameTint: '#ffffff', uFlameOuter: '#ff0000', uFlameMid: '#ffff00', uFlameCore: '#ffffff', uSparkColor: '#ff4d00', uSmokeColor: '#ffffff', uBgColor: '#000000' } },
    { id: 'gas', name: 'Gas', values: { uFlameTint: '#ffffff', uFlameOuter: '#1a3cff', uFlameMid: '#3faaff', uFlameCore: '#e3f5ff', uSparkColor: '#5aaeff', uSmokeColor: '#8ea6c8', uBgColor: '#000000' } },
    { id: 'copper', name: 'Copper', values: { uFlameTint: '#ffffff', uFlameOuter: '#009a4a', uFlameMid: '#6dff9c', uFlameCore: '#effff0', uSparkColor: '#8cff5a', uSmokeColor: '#a8c8b0', uBgColor: '#000000' } },
    { id: 'arcane', name: 'Arcane', values: { uFlameTint: '#ffffff', uFlameOuter: '#6a00ff', uFlameMid: '#d24dff', uFlameCore: '#ffe8ff', uSparkColor: '#c25aff', uSmokeColor: '#b4a0d8', uBgColor: '#000000' } },
    { id: 'ember', name: 'Ember', values: { uFlameTint: '#ffffff', uFlameOuter: '#a81000', uFlameMid: '#ff4a00', uFlameCore: '#ffb45a', uSparkColor: '#ff5a14', uSmokeColor: '#a09088', uBgColor: '#000000', uFlameHeight: 0.7, uSparkAmount: 1.5 } },
    { id: 'solar', name: 'Solar', values: { uFlameTint: '#ffffff', uFlameOuter: '#ff7a1a', uFlameMid: '#ffe6a0', uFlameCore: '#ffffff', uSparkColor: '#ffc04d', uSmokeColor: '#e8dcc8', uBgColor: '#000000' } },
  ] },
  { id: 'spacetravel', name: 'Space Travel', code: SPACE_TRAVEL, params: [
    { key: 'uStarColor', label: 'Star color', type: 'color', default: '#ffffff' },
    { key: 'uBgColor', label: 'Background', type: 'color', default: '#000000' },
    { key: 'uStarSize', label: 'Star size', type: 'range', default: 2.5, min: 0.5, max: 8, step: 0.1 },
    { key: 'uStarCount', label: 'Star count', type: 'range', default: 200, min: 25, max: 400, step: 25 },
  ], looks: [
    { id: 'warp', name: 'Warp', values: { uStarColor: '#ffffff', uBgColor: '#000000' } },
    { id: 'midnight', name: 'Midnight', values: { uStarColor: '#fff4dc', uBgColor: '#0a1330' } },
    { id: 'nebula', name: 'Nebula', values: { uStarColor: '#ffc6ef', uBgColor: '#13061f' } },
    { id: 'gold', name: 'Gold', values: { uStarColor: '#ffd690', uBgColor: '#171006' } },
    { id: 'lagoon', name: 'Lagoon', values: { uStarColor: '#a6fff0', uBgColor: '#031c22' } },
    { id: 'ember', name: 'Ember', values: { uStarColor: '#ff9e66', uBgColor: '#1c0805' } },
  ] },
  { id: 'glitters', name: 'Glitter Dust', code: GLITTERS, params: [
    { key: 'uGlitterColor', label: 'Glitter color', type: 'color', default: '#ffffff' },
    { key: 'uBgColor', label: 'Background', type: 'color', default: '#000000' },
    { key: 'uGlitterSize', label: 'Size', type: 'range', default: 1.4, min: 0.5, max: 4, step: 0.1 },
    { key: 'uSparsity', label: 'Sparsity', type: 'range', default: 18, min: 6, max: 40, step: 1 },
  ], looks: [
    { id: 'stardust', name: 'Stardust', values: { uGlitterColor: '#ffffff', uBgColor: '#000000' } },
    { id: 'gilded', name: 'Gilded', values: { uGlitterColor: '#ffc861', uBgColor: '#0e0a04' } },
    { id: 'rose', name: 'Rose', values: { uGlitterColor: '#ffa6c6', uBgColor: '#1a0811' } },
    { id: 'ice', name: 'Ice', values: { uGlitterColor: '#a3dcff', uBgColor: '#030b18' } },
    { id: 'emerald', name: 'Emerald', values: { uGlitterColor: '#80ffbb', uBgColor: '#02100a' } },
    { id: 'amethyst', name: 'Amethyst', values: { uGlitterColor: '#c9a6ff', uBgColor: '#0d0619' } },
  ] },
  { id: 'blueplanet', name: 'Blue Planet', code: BLUE_PLANET, params: [
    { key: 'uTint', label: 'Tint', type: 'color', default: '#ffffff' },
    { key: 'uRimColor', label: 'Rim', type: 'color', default: '#298cff' },
    { key: 'uRimHiColor', label: 'Rim highlight', type: 'color', default: '#99d1ff' },
    { key: 'uAtmoColor', label: 'Atmosphere', type: 'color', default: '#2973f2' },
    { key: 'uSurfaceColor', label: 'Surface', type: 'color', default: '#0b3b8f' },
    { key: 'uNightColor', label: 'Night side', type: 'color', default: '#010307' },
    { key: 'uBgColor', label: 'Space', type: 'color', default: '#040405' },
  ], looks: [
    { id: 'earth', name: 'Earth', values: { uTint: '#ffffff', uRimColor: '#298cff', uRimHiColor: '#99d1ff', uAtmoColor: '#2973f2', uSurfaceColor: '#0b3b8f', uNightColor: '#010307', uBgColor: '#040405' } },
    { id: 'mars', name: 'Mars', values: { uTint: '#ffffff', uRimColor: '#ff6a2b', uRimHiColor: '#ffc39a', uAtmoColor: '#e2552a', uSurfaceColor: '#7a2a10', uNightColor: '#070201', uBgColor: '#050404' } },
    { id: 'eclipse', name: 'Eclipse', values: { uTint: '#ffffff', uRimColor: '#ffb547', uRimHiColor: '#fff1c9', uAtmoColor: '#ff9a2e', uSurfaceColor: '#3d2408', uNightColor: '#030201', uBgColor: '#040404' } },
    { id: 'verdant', name: 'Verdant', values: { uTint: '#ffffff', uRimColor: '#3ddc97', uRimHiColor: '#c6ffe5', uAtmoColor: '#1fb57a', uSurfaceColor: '#0a4d33', uNightColor: '#010503', uBgColor: '#030504' } },
    { id: 'violet', name: 'Violet', values: { uTint: '#ffffff', uRimColor: '#a45cff', uRimHiColor: '#e6ccff', uAtmoColor: '#8a3cf2', uSurfaceColor: '#3a1080', uNightColor: '#030107', uBgColor: '#050407' } },
    { id: 'lunar', name: 'Lunar', values: { uTint: '#ffffff', uRimColor: '#c8ccd4', uRimHiColor: '#ffffff', uAtmoColor: '#8a909c', uSurfaceColor: '#3a3d44', uNightColor: '#020203', uBgColor: '#040405' } },
  ] },
  { id: 'auroraridge', name: 'Aurora Ridge', code: AURORA_RIDGE, params: [
    { key: 'uTint', label: 'Tint', type: 'color', default: '#ffffff' },
    { key: 'uCrestColor', label: 'Crest', type: 'color', default: '#754df0' },
    { key: 'uFogColor', label: 'Fog', type: 'color', default: '#bdadfc' },
    { key: 'uCoreColor', label: 'Fog core', type: 'color', default: '#faf5ff' },
    { key: 'uEdgeColor', label: 'Edge light', type: 'color', default: '#2466ff' },
    { key: 'uFrontGlow', label: 'Front glow', type: 'color', default: '#8c6bfc' },
    // The wash over the bottom of the fog, left to right.
    { key: 'uWashA', label: 'Wash 1', type: 'color', default: '#808adb' },
    { key: 'uWashB', label: 'Wash 2', type: 'color', default: '#a18ff2' },
    { key: 'uWashC', label: 'Wash 3', type: 'color', default: '#f5cceb' },
    { key: 'uWashD', label: 'Wash 4', type: 'color', default: '#ffede3' },
    { key: 'uSkyGlow', label: 'Sky glow', type: 'color', default: '#080d2b' },
    { key: 'uBgColor', label: 'Background', type: 'color', default: '#030306' },
  ], looks: [
    { id: 'lilac', name: 'Lilac', values: { uTint: '#ffffff', uCrestColor: '#754df0', uFogColor: '#bdadfc', uCoreColor: '#faf5ff', uEdgeColor: '#2466ff', uFrontGlow: '#8c6bfc', uWashA: '#808adb', uWashB: '#a18ff2', uWashC: '#f5cceb', uWashD: '#ffede3', uSkyGlow: '#080d2b', uBgColor: '#030306' } },
    { id: 'arctic', name: 'Arctic', values: { uTint: '#ffffff', uCrestColor: '#2bb8d9', uFogColor: '#a8e4f0', uCoreColor: '#f2fcff', uEdgeColor: '#1f6fff', uFrontGlow: '#5ccfe6', uWashA: '#7fb8e0', uWashB: '#8fd6e6', uWashC: '#c8f0ea', uWashD: '#f0fbf8', uSkyGlow: '#04122b', uBgColor: '#020407' } },
    { id: 'borealis', name: 'Borealis', values: { uTint: '#ffffff', uCrestColor: '#1fd18a', uFogColor: '#a6f0c8', uCoreColor: '#f2fff6', uEdgeColor: '#1fa3c4', uFrontGlow: '#4be0a0', uWashA: '#6fc4b0', uWashB: '#8fe0b0', uWashC: '#d0f2c0', uWashD: '#f6fbe6', uSkyGlow: '#041a14', uBgColor: '#020504' } },
    { id: 'dusk', name: 'Dusk', values: { uTint: '#ffffff', uCrestColor: '#e8563a', uFogColor: '#fcc3a8', uCoreColor: '#fff6ee', uEdgeColor: '#c43a6b', uFrontGlow: '#f2835a', uWashA: '#d97a8c', uWashB: '#f09a7a', uWashC: '#fcd2a8', uWashD: '#fff0d8', uSkyGlow: '#2b0d0a', uBgColor: '#060303' } },
    { id: 'mist', name: 'Mist', values: { uTint: '#ffffff', uCrestColor: '#7c8698', uFogColor: '#bcc3ce', uCoreColor: '#f6f7f8', uEdgeColor: '#5a6a85', uFrontGlow: '#a0a8b4', uWashA: '#9ca2ac', uWashB: '#b4b8be', uWashC: '#d6d8dc', uWashD: '#eeeeee', uSkyGlow: '#0c0e12', uBgColor: '#030304' } },
    { id: 'gold', name: 'Gold', values: { uTint: '#ffffff', uCrestColor: '#c98a2b', uFogColor: '#f2dcae', uCoreColor: '#fffaf0', uEdgeColor: '#a0602a', uFrontGlow: '#e0b060', uWashA: '#d8b890', uWashB: '#e8c890', uWashC: '#f8e2c0', uWashD: '#fff4e4', uSkyGlow: '#1a1004', uBgColor: '#040303' } },
  ] },
  { id: 'emberpool', name: 'Ember Pool', code: EMBER_POOL, params: [
    { key: 'uTint', label: 'Tint', type: 'color', default: '#ffffff' },
    // Hue only; the shader keeps each source's original HDR intensity.
    { key: 'uGlowA', label: 'Upper glow', type: 'color', default: '#4102ff' },
    { key: 'uGlowB', label: 'Lower glow', type: 'color', default: '#ff4c06' },
    { key: 'uGlowC', label: 'Edge glow', type: 'color', default: '#ff0b50' },
    { key: 'uGlowD', label: 'Bounce', type: 'color', default: '#ff3a0f' },
    { key: 'uBgColor', label: 'Background', type: 'color', default: '#030107' },
  ], looks: [
    { id: 'ember', name: 'Ember', values: { uTint: '#ffffff', uGlowA: '#4102ff', uGlowB: '#ff4c06', uGlowC: '#ff0b50', uGlowD: '#ff3a0f', uBgColor: '#030107' } },
    { id: 'lagoon', name: 'Lagoon', values: { uTint: '#ffffff', uGlowA: '#1f4dff', uGlowB: '#00d1b2', uGlowC: '#0090ff', uGlowD: '#00e0c0', uBgColor: '#010407' } },
    { id: 'sunset', name: 'Sunset', values: { uTint: '#ffffff', uGlowA: '#ff2e63', uGlowB: '#ffaa00', uGlowC: '#ff5a1f', uGlowD: '#ffc04d', uBgColor: '#060201' } },
    { id: 'ultraviolet', name: 'Ultraviolet', values: { uTint: '#ffffff', uGlowA: '#2a0fff', uGlowB: '#c400ff', uGlowC: '#7a00ff', uGlowD: '#ff1fa0', uBgColor: '#030108' } },
    { id: 'aurora', name: 'Aurora', values: { uTint: '#ffffff', uGlowA: '#19e68c', uGlowB: '#8a3cff', uGlowC: '#00b8a0', uGlowD: '#b04dff', uBgColor: '#010406' } },
    { id: 'silver', name: 'Silver', values: { uTint: '#ffffff', uGlowA: '#8f9bb3', uGlowB: '#e8e2d8', uGlowC: '#a8a8b0', uGlowD: '#d0ccc4', uBgColor: '#030304' } },
  ] },
  { id: 'neonvignette', name: 'Neon Vignette', code: NEON_VIGNETTE, params: [
    { key: 'uTint', label: 'Tint', type: 'color', default: '#ffffff' },
    { key: 'uGlowA', label: 'Bank 1', type: 'color', default: '#ff1868' },
    { key: 'uGlowB', label: 'Bank 2', type: 'color', default: '#6602ff' },
    { key: 'uGlowC', label: 'Fill', type: 'color', default: '#6c06ff' },
    { key: 'uBgColor', label: 'Background', type: 'color', default: '#030106' },
  ], looks: [
    { id: 'orchid', name: 'Orchid', values: { uTint: '#ffffff', uGlowA: '#ff1868', uGlowB: '#6602ff', uGlowC: '#6c06ff', uBgColor: '#030106' } },
    { id: 'lagoon', name: 'Lagoon', values: { uTint: '#ffffff', uGlowA: '#00d4c8', uGlowB: '#1f4dff', uGlowC: '#1f6fff', uBgColor: '#010306' } },
    { id: 'sunset', name: 'Sunset', values: { uTint: '#ffffff', uGlowA: '#ff9500', uGlowB: '#ff2e5a', uGlowC: '#ff5a3c', uBgColor: '#050201' } },
    { id: 'cyber', name: 'Cyber', values: { uTint: '#ffffff', uGlowA: '#00e5ff', uGlowB: '#b000ff', uGlowC: '#6a00ff', uBgColor: '#020108' } },
    { id: 'emerald', name: 'Emerald', values: { uTint: '#ffffff', uGlowA: '#00e68a', uGlowB: '#00a3a3', uGlowC: '#00c48a', uBgColor: '#010402' } },
    { id: 'silver', name: 'Silver', values: { uTint: '#ffffff', uGlowA: '#d8dce4', uGlowB: '#8a93a6', uGlowC: '#6a7180', uBgColor: '#030304' } },
  ] },
  { id: 'electricvignette', name: 'Electric Vignette', code: ELECTRIC_VIGNETTE, params: [
    { key: 'uTint', label: 'Tint', type: 'color', default: '#ffffff' },
    { key: 'uGlowA', label: 'Glow', type: 'color', default: '#3302ff' },
    { key: 'uBgColor', label: 'Background', type: 'color', default: '#03010b' },
  ], looks: [
    { id: 'cobalt', name: 'Cobalt', values: { uTint: '#ffffff', uGlowA: '#3302ff', uBgColor: '#03010b' } },
    { id: 'ultraviolet', name: 'Ultraviolet', values: { uTint: '#ffffff', uGlowA: '#9a00ff', uBgColor: '#07010b' } },
    { id: 'crimson', name: 'Crimson', values: { uTint: '#ffffff', uGlowA: '#ff0a3c', uBgColor: '#0b0103' } },
    { id: 'emerald', name: 'Emerald', values: { uTint: '#ffffff', uGlowA: '#00e070', uBgColor: '#010a05' } },
    { id: 'teal', name: 'Teal', values: { uTint: '#ffffff', uGlowA: '#00b8c8', uBgColor: '#01070a' } },
    { id: 'silver', name: 'Silver', values: { uTint: '#ffffff', uGlowA: '#c0c8d8', uBgColor: '#040406' } },
  ] },
  { id: 'spectrumdrift', name: 'Spectrum Drift', code: SPECTRUM_DRIFT, params: [
    { key: 'uTint', label: 'Tint', type: 'color', default: '#ffffff' },
    // The four stops the drift cycles through, in order.
    { key: 'uGlowA', label: 'Stop 1', type: 'color', default: '#ff5205' },
    { key: 'uGlowB', label: 'Stop 2', type: 'color', default: '#ff1071' },
    { key: 'uGlowC', label: 'Stop 3', type: 'color', default: '#6d05ff' },
    { key: 'uGlowD', label: 'Stop 4', type: 'color', default: '#3300ff' },
    { key: 'uBgColor', label: 'Background', type: 'color', default: '#020204' },
  ], looks: [
    { id: 'dusk', name: 'Dusk', values: { uTint: '#ffffff', uGlowA: '#ff5205', uGlowB: '#ff1071', uGlowC: '#6d05ff', uGlowD: '#3300ff', uBgColor: '#020204' } },
    { id: 'ocean', name: 'Ocean', values: { uTint: '#ffffff', uGlowA: '#00d1b2', uGlowB: '#00a3ff', uGlowC: '#1f4dff', uGlowD: '#6a3cff', uBgColor: '#010306' } },
    { id: 'aurora', name: 'Aurora', values: { uTint: '#ffffff', uGlowA: '#19e68c', uGlowB: '#00b8c4', uGlowC: '#7a3cff', uGlowD: '#ff3da0', uBgColor: '#020306' } },
    { id: 'inferno', name: 'Inferno', values: { uTint: '#ffffff', uGlowA: '#ff3d00', uGlowB: '#ff8a00', uGlowC: '#ffc400', uGlowD: '#ff1a1a', uBgColor: '#040201' } },
    { id: 'candy', name: 'Candy', values: { uTint: '#ffffff', uGlowA: '#ff8ac0', uGlowB: '#a08cff', uGlowC: '#6ad4ff', uGlowD: '#ffb08a', uBgColor: '#040306' } },
    { id: 'silver', name: 'Silver', values: { uTint: '#ffffff', uGlowA: '#e8e4dc', uGlowB: '#9aa4b8', uGlowC: '#c8ccd4', uGlowD: '#6a7488', uBgColor: '#030304' } },
  ] },
  ...LAB_SHADER_PRESETS,
];

export function getShaderPreset(id) {
  return SHADER_PRESETS.find((p) => p.id === id) || null;
}

export const DEFAULT_SHADER_CODE = SILK;
