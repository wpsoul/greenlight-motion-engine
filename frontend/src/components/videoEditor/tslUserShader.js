/*
 * User-authored TSL shaders — A PROTOTYPE, WITH NO PRODUCTION CALLER.
 *
 * STATUS (settled at the WebGPU cutover). Nothing in the shipping app reaches
 * this module. Its two consumers are:
 *
 *   * `shaderBackgroundNodes.materialForCustomTsl()` — never had a caller.
 *   * `adjustmentEffectNodes.createCustomEffectNodeMaterial()` — was called by
 *     materialFactory for `effect.id === 'custom'`. That call is REMOVED, and
 *     not merely because of the eval: a custom effect's body is GLSL (its own
 *     validator requires `void mainImage(...)`) while this compiler requires
 *     JavaScript, so the path could only ever throw. Custom effects are now
 *     reported per project by webgpuPreflight.js and skipped with a reason.
 *
 * WHY IT STAYS. The migration decision on record is that if user shader
 * authoring returns it is TSL, and that user-supplied TSL must never be eval'd
 * raw — interpreted, sandboxed, or driven through a curated node-builder over
 * whitelisted nodes, the same rule the keyframe ƒx language follows. This file
 * is the measured starting point for that work, kept with its lab
 * (html/webgpu-migration/port/tsl-user.html) and its test
 * (tests/webgpu-migration/verify_tsl_user_shader.js) so the namespace and the
 * failure modes stay exercised. WIRING IT TO USER DATA AGAIN REQUIRES REPLACING
 * `new Function` FIRST. The analysis below is what that replacement must beat.
 *
 * ── original notes ─────────────────────────────────────────────────────────
 *
 * The GLSL era let a project carry shader SOURCE and handed it to the driver,
 * which sandboxed it. TSL has no equivalent: a TSL shader IS JavaScript that
 * builds a node graph, so running one means running user JS.
 *
 * WHAT THIS DOES, PLAINLY: user source is compiled with `new Function` in strict
 * mode and called with ONE argument — a frozen namespace of TSL builders and the
 * shader's inputs. Nothing else is passed in. The function body cannot see this
 * module's scope, and every name it uses must come from that argument or be a
 * JS built-in.
 *
 * WHAT THIS IS NOT: a security boundary. Determined code can still reach the
 * global object through constructor chains, exactly as it can in any
 * `new Function`. That is an accepted trade for this product — a project's
 * shaders are authored by the person opening the project, the same trust level
 * as the project file itself, which already drives the whole renderer. It is NOT
 * a model for running shaders downloaded from strangers, and if that ever
 * becomes a use case this needs a worker with a serialised graph instead.
 *
 * The keyframe ƒx expression language is interpreted rather than eval'd, and the
 * difference is deliberate: that language is small and closed, so interpreting
 * it is cheap. TSL is an open API surface over three's node system — an
 * interpreter for it would be a re-implementation of TSL that drifts.
 */
import * as TSL from 'three/tsl';

/*
 * The namespace a user shader sees. Explicit rather than `...TSL`, for two
 * reasons: it documents the supported surface in one readable place, and it
 * keeps a three upgrade from silently widening what projects may depend on.
 */
const EXPORTED = [
  // constructors + conversion
  'float', 'int', 'uint', 'bool', 'vec2', 'vec3', 'vec4', 'ivec2', 'ivec3', 'ivec4',
  'mat2', 'mat3', 'mat4', 'color',
  // maths
  'add', 'sub', 'mul', 'div', 'mod', 'abs', 'sign', 'floor', 'ceil', 'round', 'trunc',
  'fract', 'min', 'max', 'clamp', 'saturate', 'mix', 'step', 'smoothstep',
  'pow', 'exp', 'exp2', 'log', 'log2', 'sqrt', 'inverseSqrt',
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan',
  'degrees', 'radians', 'length', 'distance', 'dot', 'cross', 'normalize',
  'reflect', 'refract', 'faceForward', 'transformDirection',
  'dFdx', 'dFdy', 'fwidth', 'select', 'oneMinus', 'negate', 'reciprocal',
  // control flow + structure
  'Fn', 'If', 'Loop', 'Break', 'Continue', 'Return', 'Discard', 'Switch',
  'uniform', 'uniformArray', 'texture', 'attribute', 'varying', 'array', 'property',
  // built-in inputs
  'uv', 'screenCoordinate', 'screenSize', 'screenUV', 'viewportCoordinate',
  'positionGeometry', 'positionLocal', 'positionWorld', 'positionView',
  'normalGeometry', 'normalLocal', 'normalWorld', 'normalView',
  'cameraPosition', 'cameraProjectionMatrix', 'cameraViewMatrix',
  'modelViewMatrix', 'modelWorldMatrix', 'modelNormalMatrix',
  'time', 'deltaTime', 'frameId',
  // noise / hashing helpers three ships
  'hash', 'range', 'oscSine', 'oscSquare', 'oscTriangle', 'oscSawtooth',
  'remap', 'remapClamp', 'rotate', 'rotateUV', 'spherizeUV', 'matcapUV',
  'luminance', 'saturation', 'vibrance', 'hue', 'posterize', 'toneMapping',
  'mrt', 'output', 'blendColor', 'blendBurn', 'blendDodge', 'blendOverlay', 'blendScreen',
];

let cachedNamespace = null;
function tslNamespace() {
  if (cachedNamespace) return cachedNamespace;
  const ns = {};
  const missing = [];
  for (const k of EXPORTED) {
    if (TSL[k] === undefined) { missing.push(k); continue; }
    ns[k] = TSL[k];
  }
  // A name this file promises but three no longer exports would otherwise fail
  // inside a user's shader as a bare "x is not a function", pointing at their
  // code instead of at this list.
  if (missing.length && typeof console !== 'undefined') {
    console.warn('[tsl] namespace names not present in this three build:', missing.join(', '));
  }
  cachedNamespace = Object.freeze(ns);
  return cachedNamespace;
}

/** The names a shader can use, for editor autocomplete and docs. */
export function tslShaderNamespaceNames() {
  return Object.keys(tslNamespace()).sort();
}

/**
 * Compile user TSL into a node.
 *
 * `source` is the BODY of a function that returns a node — the same shape the
 * GLSL path used, where the user wrote statements and ended with an assignment.
 * Everything in the namespace, plus everything in `inputs`, is in scope by name.
 *
 * Returns `{ node, error }` rather than throwing: a broken shader must not take
 * the render loop down with it, and the caller needs the message to show.
 */
export function compileUserTsl(source, inputs = {}) {
  const src = String(source || '').trim();
  if (!src) return { node: null, error: 'empty shader' };

  const ns = tslNamespace();
  const names = [...Object.keys(ns), ...Object.keys(inputs)];
  const values = [...Object.keys(ns).map((k) => ns[k]), ...Object.keys(inputs).map((k) => inputs[k])];

  let build;
  try {
    // Strict mode matters: it stops an accidental bare assignment from creating
    // a global, which would leak state between two shaders in one project.
    // eslint-disable-next-line no-new-func
    build = new Function(...names, `"use strict";\n${src}`);
  } catch (err) {
    return { node: null, error: `syntax: ${err.message}` };
  }

  try {
    const node = build(...values);
    if (node === undefined || node === null) {
      return { node: null, error: 'shader returned nothing — end with `return <node>`' };
    }
    return { node, error: null };
  } catch (err) {
    // A throw here is usually a real TSL misuse (wrong arity, a name that is not
    // a node), and its message is the most useful thing the user can be shown.
    return { node: null, error: `build: ${err.message}` };
  }
}

/**
 * Compile-check without keeping the result — the TSL equivalent of
 * validateShaderCode(). Returns an error string, or null when it builds.
 */
export function validateUserTsl(source, inputs = {}) {
  return compileUserTsl(source, inputs).error;
}

/** Stable cache key for a compiled user shader. */
export function userTslKey(source) {
  const s = String(source || '');
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `tsl:${h >>> 0}`;
}
