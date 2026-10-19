/*
 * Installed effect packages (Effects SDK) — list, load, validate, prove, register.
 *
 * A package is one ES module (`<id>.js`, or `effect.js` in a .gleffect zip)
 * installed under MEDIA_DIR/effects by the backend. It declares named params and
 * its shading for one engine or both:
 *
 *   `fragment`         → a GLSL `vec4 fx(vec2 uv)` body for the WebGL engine,
 *                        compiled into the same prelude and wrapper as every
 *                        built-in effect;
 *   `fragmentNode(ctx)`→ a TSL node function for the WebGPU engine, called inside
 *                        the effect material's Fn (adjustmentEffectNodes);
 *   `passes`           → several of those, each reading earlier passes by name
 *                        (blurs, glows) — the chain's declarative pass walk.
 *
 * Package images (`textures`, under assets/ in a .gleffect) bind as samplers.
 *
 * The params become an ordinary registry def — numbers take uParams slots,
 * colours uColors slots — so panel fields, `fx:<eid>:<param>` keyframes, mix,
 * active range and export all come from the generic chain. Nothing here runs
 * per frame.
 *
 * Every revision is PROVEN once on each engine it supports (effectProof.js: a
 * real compile and a render on a private GPU context), and the result goes back
 * to the backend as the package's `status`, so an agent reads why a package
 * failed instead of asking the user. The proof's picture is the thumbnail.
 *
 * Packages never come from project data: a project stores `local:<id>` + params,
 * and the code is whatever this app has installed. That is the line the
 * withdrawn Custom GLSL effect crossed.
 */
import {
  EFFECT_MAIN,
  EFFECT_PRELUDE,
  replaceLocalEffects,
  upsertLocalEffect,
} from './adjustmentEffects';
import { overlayEffectMetadata } from './capabilityMetadata';
import { importModuleFromSource, runStaticGate, stripCommentsAndStrings } from './packageGate';
import { selectedBackend } from './videoRenderer';
import { buildFragmentSource, validateShaderCode } from '../../utils/shaderBackground';
import { packageAssetUrl } from './packageAssetUrls';

const API_BASE = import.meta.env?.VITE_API_BASE_URL || '/api';

// Slots 16–27 of uParams are the chain's own (LUT, track, plate, path).
export const MAX_NUMBER_PARAMS = 16;
export const MAX_COLOR_PARAMS = 5;
export const MAX_PASSES = 8;
export const MAX_TEXTURES = 4;
// The chain's pass samplers, in the order a pass's `inputs` bind to them.
const PASS_SAMPLERS = ['uTexture', 'uTexture1', 'uTexture2', 'uTexture3'];
// Also a GLSL identifier: params read as P_<key> / C_<key>, inputs B_<name>, images T_<key>.
const NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const NUMBER_TYPES = new Set(['number', 'range', 'select', 'switch']);
const SCOPES = new Set(['layer', 'adjustment']);
const ENGINES = ['webgl', 'webgpu'];
const BUFFERS = new Set(['source', 'matte']);
const TEXTURE_FILE_RE = /^assets\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.(?:png|jpe?g|webp)$/i;
const WRAPS = new Set(['clamp', 'repeat', 'mirror']);
const GROUP = 'Installed';

const localType = (id) => `local:${id}`;
const activeEngine = () => (selectedBackend() === 'webgpu' ? 'webgpu' : 'webgl');

function stageError(stage, message) {
  const error = new Error(message);
  error.stage = stage;
  return error;
}

// ── Params ──────────────────────────────────────────────────────────────────

// The package's named params → registry params with slots, in declaration order.
export function buildEffectParams(params) {
  let slot = 0;
  let colorSlot = 0;
  return params.map((p) => {
    const label = typeof p.label === 'string' && p.label.trim() ? p.label : p.key;
    if (p.type === 'color') return { key: p.key, type: 'color', label, default: p.default, colorSlot: colorSlot++ };
    const base = { key: p.key, label, slot: slot++ };
    if (p.type === 'select') {
      return { ...base, type: 'select', default: Number(p.default), options: p.options.map((o) => ({ value: Number(o.value), label: String(o.label) })) };
    }
    if (p.type === 'switch') {
      return { ...base, type: 'select', default: p.default ? 1 : 0, options: [{ value: 0, label: 'Off' }, { value: 1, label: 'On' }] };
    }
    const out = { ...base, min: Number(p.min), max: Number(p.max), step: Number(p.step) > 0 ? Number(p.step) : 0.01, default: Number(p.default) };
    if (typeof p.suffix === 'string' && p.suffix.length <= 8) out.suffix = p.suffix;
    if (p.static === true) out.static = true;
    return out;
  });
}

// GLSL names for the params and images: `P_amount` is `uParams[0]`, `C_tint` is
// `uColors[0]`, `T_grain` a sampler the material binds to the package image.
function glslHeader(params, textures) {
  return [
    ...params.map((p) => (p.type === 'color' ? `#define C_${p.key} uColors[${p.colorSlot}]` : `#define P_${p.key} uParams[${p.slot}]`)),
    ...textures.map((t) => `uniform sampler2D T_${t.key};`),
  ].join('\n');
}

// ── Contract ────────────────────────────────────────────────────────────────

function validateParams(params, problems) {
  if (!Array.isArray(params)) { problems.push('`params` must be an array'); return; }
  const seen = new Set();
  let numbers = 0;
  let colors = 0;
  for (const p of params) {
    if (!p || typeof p !== 'object') { problems.push('every param must be an object'); continue; }
    const where = `param "${p.key}"`;
    if (!NAME_RE.test(String(p.key || ''))) { problems.push(`param key "${p.key}" must be a letter followed by letters, digits or _ (it is also a GLSL name)`); continue; }
    if (seen.has(p.key)) problems.push(`${where} is declared twice`);
    seen.add(p.key);
    if (p.type === 'color') {
      colors += 1;
      if (typeof p.default !== 'string' || !/^#[0-9a-f]{6}$/i.test(p.default)) problems.push(`${where}: a colour default is a #rrggbb string`);
      continue;
    }
    if (!NUMBER_TYPES.has(p.type || 'number')) { problems.push(`${where}: type must be range, number, select, switch or color`); continue; }
    numbers += 1;
    if (p.type === 'select') {
      if (!Array.isArray(p.options) || !p.options.length || !p.options.every((o) => Number.isFinite(Number(o?.value)) && typeof o?.label === 'string')) {
        problems.push(`${where}: a select needs options [{ value: number, label: string }]`);
      }
    } else if (p.type !== 'switch') {
      if (![p.min, p.max, p.default].every((v) => Number.isFinite(Number(v))) || Number(p.min) >= Number(p.max)) {
        problems.push(`${where}: needs numeric min < max and a default`);
      }
    }
  }
  if (numbers > MAX_NUMBER_PARAMS) problems.push(`at most ${MAX_NUMBER_PARAMS} number params (found ${numbers})`);
  if (colors > MAX_COLOR_PARAMS) problems.push(`at most ${MAX_COLOR_PARAMS} colour params (found ${colors})`);
}

const hasGlsl = (x) => typeof x?.fragment === 'string' && /\bvec4\s+fx\s*\(\s*vec2\b/.test(x.fragment);
const hasTsl = (x) => typeof x?.fragmentNode === 'function';

function validatePasses(passes, problems) {
  if (!Array.isArray(passes) || !passes.length) { problems.push('`passes` must be a non-empty array'); return; }
  if (passes.length > MAX_PASSES) problems.push(`at most ${MAX_PASSES} passes (found ${passes.length})`);
  const seen = new Set();
  passes.forEach((pass, i) => {
    const last = i === passes.length - 1;
    const key = String(pass?.key || '');
    const where = `pass "${key || i}"`;
    if (!pass || typeof pass !== 'object') { problems.push(`pass ${i} must be an object`); return; }
    if (!NAME_RE.test(key) || key === 'main' || BUFFERS.has(key)) {
      problems.push(`${where}: key must be a GLSL-style name other than main, source or matte`);
    }
    if (seen.has(key)) problems.push(`${where} is declared twice`);
    if (pass.inputs != null) {
      if (!Array.isArray(pass.inputs) || !pass.inputs.length || pass.inputs.length > PASS_SAMPLERS.length) {
        problems.push(`${where}: inputs is a list of 1–${PASS_SAMPLERS.length} buffer names`);
      } else {
        for (const name of pass.inputs) {
          if (!BUFFERS.has(name) && !seen.has(name)) problems.push(`${where}: input "${name}" is not source, matte or an earlier pass`);
        }
      }
    }
    if (pass.scale != null) {
      const axes = Array.isArray(pass.scale) ? pass.scale : [pass.scale];
      if (last) problems.push(`${where}: the last pass writes the output at full size, so it takes no scale`);
      else if (axes.length > 2 || !axes.every((v) => Number.isFinite(v) && v >= 1 / 16 && v <= 1)) {
        problems.push(`${where}: scale is a number (or [x, y]) from 1/16 to 1`);
      }
    }
    seen.add(key);
  });
}

// Which engines the module can draw on, from what it exports; a declared
// `renderer` must agree with it.
function engineSupport(d, problems) {
  const units = Array.isArray(d.passes) ? d.passes : [d];
  const gl = units.length > 0 && units.every(hasGlsl);
  const gpu = units.length > 0 && units.every(hasTsl);
  const engines = [gl && 'webgl', gpu && 'webgpu'].filter(Boolean);
  const unit = Array.isArray(d.passes) ? 'every pass' : 'the package';
  const glslNeed = `${unit} exports \`fragment\`, a GLSL string defining \`vec4 fx(vec2 uv)\``;
  const tslNeed = `${unit} exports \`fragmentNode(ctx)\`, a function returning a vec4 node`;
  if (d.renderer === 'webgl' && !gl) problems.push(`for renderer 'webgl', ${glslNeed}`);
  else if (d.renderer === 'webgpu' && !gpu) problems.push(`for renderer 'webgpu', ${tslNeed}`);
  else if (d.renderer === 'both' && !(gl && gpu)) problems.push(`for renderer 'both', ${glslNeed} AND ${tslNeed}`);
  else if (d.renderer != null && !['webgl', 'webgpu', 'both'].includes(d.renderer)) problems.push("`renderer` is 'webgl', 'webgpu' or 'both'");
  else if (!engines.length) problems.push(`${glslNeed} (WebGL), or ${tslNeed} (WebGPU), or both`);
  if (d.renderer === 'webgl') return ['webgl'];
  if (d.renderer === 'webgpu') return ['webgpu'];
  return engines;
}

function validateTextures(textures, entry, problems) {
  if (textures == null) return;
  if (!Array.isArray(textures)) { problems.push('`textures` must be an array'); return; }
  if (textures.length > MAX_TEXTURES) problems.push(`at most ${MAX_TEXTURES} textures (found ${textures.length})`);
  const assets = new Set((entry?.assets || []).map((a) => `assets/${a}`));
  const seen = new Set();
  for (const t of textures) {
    const where = `texture "${t?.key}"`;
    if (!t || !NAME_RE.test(String(t.key || ''))) { problems.push(`texture key "${t?.key}" must be a GLSL-style name`); continue; }
    if (seen.has(t.key)) problems.push(`${where} is declared twice`);
    seen.add(t.key);
    if (!TEXTURE_FILE_RE.test(String(t.file || ''))) { problems.push(`${where}: file is a .png, .jpg or .webp under assets/`); continue; }
    if (entry && !entry.packaged) problems.push(`${where}: images need a .gleffect package with the file in its assets/ folder`);
    else if (entry && !assets.has(t.file)) problems.push(`${where}: ${t.file} is not in the package`);
    if (t.wrap != null && !WRAPS.has(t.wrap)) problems.push(`${where}: wrap is clamp, repeat or mirror`);
    if (t.filter != null && t.filter !== 'linear' && t.filter !== 'nearest') problems.push(`${where}: filter is linear or nearest`);
  }
}

function validateShape(mod, entry) {
  const d = mod?.default && typeof mod.default === 'object' ? { ...mod, ...mod.default } : mod || {};
  const problems = [];
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(d.id || ''))) problems.push('`id` must be kebab-case');
  if (typeof d.name !== 'string' || !d.name.trim()) problems.push('`name` must be a non-empty string');
  validateParams(d.params, problems);
  if (d.passes != null) validatePasses(d.passes, problems);
  const engines = engineSupport(d, problems);
  validateTextures(d.textures, entry, problems);
  if (d.scopes != null && !(Array.isArray(d.scopes) && d.scopes.length && d.scopes.every((s) => SCOPES.has(s)))) {
    problems.push("`scopes` lists 'layer' and/or 'adjustment'");
  }
  if (d.layerMatte != null && d.layerMatte !== 'clip' && d.layerMatte !== 'expand') problems.push("`layerMatte` is 'clip' or 'expand'");
  if (problems.length) throw stageError('shape', `Effect package: ${problems.join('; ')}.`);
  return { d, engines };
}

// The chain's declarative pass form (motionEffects.js header) built from the
// package's passes: inputs bind to uTexture…uTexture3 in order and read as
// B_<name> in GLSL; the last pass is the chain's `main`, the only one Mix fades.
function toChainPasses(d, header, engines) {
  return d.passes.map((pass, i) => {
    const last = i === d.passes.length - 1;
    const inputs = pass.inputs || [i === 0 ? 'source' : d.passes[i - 1].key];
    const key = last ? 'main' : pass.key;
    const out = {
      key,
      label: pass.key,
      target: last ? 'out' : pass.key,
      main: last,
      inputs: Object.fromEntries(inputs.map((name, slot) => [PASS_SAMPLERS[slot], name])),
      inputNames: [...inputs],
    };
    if (!last && pass.scale != null) out.scale = Array.isArray(pass.scale) ? [...pass.scale] : pass.scale;
    if (engines.includes('webgl')) {
      const defines = inputs.map((name, slot) => `#define B_${name} ${PASS_SAMPLERS[slot]}`).join('\n');
      out.fragment = `${header}\n${defines}\n${pass.fragment}`;
      out.fragmentSource = pass.fragment;
    }
    if (engines.includes('webgpu')) out.fragmentNode = pass.fragmentNode;
    return out;
  });
}

// The registry def a loaded package becomes.
function toDef(d, engines, entry) {
  const params = buildEffectParams(d.params);
  const textures = (d.textures || []).map((t) => ({
    key: t.key, file: t.file, wrap: t.wrap || 'clamp', filter: t.filter || 'linear', image: null,
  }));
  const header = glslHeader(params, textures);
  const def = {
    id: localType(d.id),
    localId: d.id,
    name: d.name.trim(),
    description: typeof d.description === 'string' ? d.description : '',
    group: GROUP,
    renderer: engines.length > 1 ? 'both' : engines[0],
    renderers: engines,
    animated: d.animated !== false,
    params,
    textures,
    isLocal: true,
    ready: true,
    lazy: false,
    error: null,
    rev: entry?.modified_at ?? 0,
    packaged: !!entry?.packaged,
    thumbnail: entry?.thumbnail || null,
  };
  if (Array.isArray(d.scopes)) def.scopes = [...d.scopes];
  if (d.layerMatte) def.layerMatte = d.layerMatte;
  if (Array.isArray(d.passes)) {
    def.passes = toChainPasses(d, header, engines);
  } else {
    if (engines.includes('webgl')) {
      def.fragment = `${header}\n${d.fragment}`;
      def.fragmentSource = d.fragment;
    }
    if (engines.includes('webgpu')) def.fragmentNode = d.fragmentNode;
  }
  return def;
}

// GLSL is checked in a throwaway GLSL ES context against the real prelude and
// wrapper — the clearest line numbers there are. The proof compiles it again on
// a real WebGL2 context, and the TSL on a real WebGPU device.
// The compiler numbers lines of the whole assembled shader; an agent needs the
// line of ITS `fragment`, and the line itself.
function locateGlslError(error, unit) {
  const match = /ERROR:\s*\d+:(\d+):/.exec(error);
  if (!match || !unit.fragmentSource) return error;
  const options = { prelude: EFFECT_PRELUDE, wrapper: EFFECT_MAIN };
  const assembled = buildFragmentSource(unit.fragment, options);
  const start = assembled.indexOf(unit.fragmentSource);
  if (start < 0) return error;
  const first = assembled.slice(0, start).split('\n').length;
  const line = Number(match[1]) - first + 1;
  const lines = unit.fragmentSource.split('\n');
  if (line < 1 || line > lines.length) return error;
  return `${error.replace(/ERROR:\s*\d+:\d+:\s*/, '')} — line ${line} of \`fragment\`: ${lines[line - 1].trim()}`;
}

function validateGlsl(def) {
  const units = def.passes ? def.passes.filter((p) => p.fragment) : (def.fragment ? [def] : []);
  for (const unit of units) {
    const raw = validateShaderCode(unit.fragment, { prelude: EFFECT_PRELUDE, wrapper: EFFECT_MAIN });
    // The driver's info log ends in a newline and a NUL; neither belongs in the status.
    const error = raw && String(raw).replace(/[\s\u0000]+$/, '');
    if (error) throw stageError('glsl', `GLSL${def.passes ? ` (pass "${unit.label}")` : ''}: ${locateGlslError(error, unit)}`);
  }
}

async function prepareEffect(source, entry) {
  const violations = runStaticGate(source);
  if (violations.length) throw stageError('gate', `Effect uses APIs outside the package contract: ${violations.join(', ')}.`);
  if (/(^|[\n;{])\s*import\s/.test(stripCommentsAndStrings(source))) {
    throw stageError('gate', 'An effect package imports nothing: everything it needs arrives in its shading context.');
  }
  let mod;
  try {
    mod = await importModuleFromSource(source, 'Effect');
  } catch (error) {
    throw stageError('module', error?.message || String(error));
  }
  const { d, engines } = validateShape(mod, entry);
  if (entry && d.id !== entry.id) throw stageError('shape', `Stored id "${entry.id}" does not match module id "${d.id}".`);
  const def = toDef(d, engines, entry);
  validateGlsl(def);
  return def;
}

// ── Package images ─────────────────────────────────────────────────────────

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`could not load ${url}`));
    img.src = url;
  });
}

// Decoded once per revision; each engine makes its own texture from the image.
async function loadTextures(def, entry) {
  if (!def.textures.length) return;
  try {
    await Promise.all(def.textures.map(async (t) => {
      t.image = await loadImage(await packageAssetUrl(`${entry.assetBase}${t.file.slice('assets/'.length)}?v=${entry.modified_at}`));
    }));
  } catch (error) {
    throw stageError('textures', `Effect image: ${error?.message || error}`);
  }
}

// ── Metadata + status ──────────────────────────────────────────────────────

function effectMetadata(def) {
  return {
    schemaVersion: 1,
    kind: 'effect',
    ...overlayEffectMetadata(def),
    id: def.localId,
    type: def.id,
    renderer: def.renderer,
    renderers: [...def.renderers],
    passes: def.passes ? def.passes.length : 1,
    textures: def.textures.map((t) => t.key),
    description: def.description,
  };
}

async function putJson(path, body) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path} failed (${response.status})`);
  return response.json();
}

async function publishMetadata(entry, def) {
  const metadata = effectMetadata(def);
  if (JSON.stringify(entry.metadata || null) === JSON.stringify(metadata)) return;
  try {
    await putJson(`/effects/local/${encodeURIComponent(entry.id)}/metadata`, metadata);
  } catch (error) {
    console.warn(`[effects] Could not publish capabilities for "${entry.id}":`, error?.message || error);
  }
}

async function publishStatus(entry, status) {
  try {
    await putJson(`/effects/local/${encodeURIComponent(entry.id)}/status`, status);
  } catch (error) {
    console.warn(`[effects] Could not publish the check of "${entry.id}":`, error?.message || error);
  }
}

async function publishThumbnail(entry, blob) {
  try {
    const response = await fetch(`${API_BASE}/effects/local/${encodeURIComponent(entry.id)}/thumbnail?rev=${entry.modified_at}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/webp' },
      body: blob,
    });
    if (!response.ok) throw new Error(`thumbnail upload failed (${response.status})`);
    return (await response.json()).thumbnail || null;
  } catch (error) {
    console.warn(`[effects] Could not save the thumbnail of "${entry.id}":`, error?.message || error);
    return null;
  }
}

// The stored check, if it is about THIS revision.
const storedStatus = (entry) => (entry?.status && entry.status.rev === entry.modified_at ? entry.status : null);

// An engine needs proving here when no check of this revision says how it went
// — or the last one was skipped because that machine could not run it.
function enginesToProve(def, stored) {
  return def.renderers.filter((engine) => {
    const result = stored?.engines?.[engine];
    return !result || (!result.ok && !result.error && result.skipped);
  });
}

/*
 * Prove what is not proven yet, publish the check, and say whether THIS
 * session's engine may draw it. Returns { status, error }: `error` (with its
 * stage) when the engine the editor runs failed — the package then loads as
 * failed here, with the compiler's own message on its card.
 */
async function checkEffect(def, entry) {
  const stored = storedStatus(entry);
  const engines = { ...(stored?.engines || {}) };
  const warnings = [...(stored?.warnings || [])];
  const toProve = enginesToProve(def, stored);
  let thumbnailBlob = null;
  if (toProve.length) {
    const { proveEffect } = await import('./effectProof.js');
    const active = activeEngine();
    // The session's own engine first: its picture is the one the user sees.
    toProve.sort((a, b) => (a === active ? -1 : b === active ? 1 : 0));
    for (const engine of toProve) {
      const result = await proveEffect(def, engine);
      engines[engine] = { ok: result.ok, error: result.error || null, stage: result.stage || null, skipped: result.skipped || null };
      for (const w of result.warnings || []) if (!warnings.includes(w)) warnings.push(w);
      if (result.ok && result.thumbnail && !thumbnailBlob) thumbnailBlob = result.thumbnail;
    }
  }
  const checked = ENGINES.filter((engine) => engines[engine] && !engines[engine].skipped);
  const failedEngine = checked.find((engine) => !engines[engine].ok);
  const status = {
    rev: entry.modified_at,
    ok: checked.length > 0 && !failedEngine,
    error: failedEngine ? `${failedEngine === 'webgl' ? 'WebGL' : 'WebGPU'}: ${engines[failedEngine].error}` : (checked.length ? null : 'Could not be checked on this computer.'),
    stage: failedEngine ? engines[failedEngine].stage : null,
    engines,
    warnings,
    checkedOn: activeEngine(),
    thumbnail: !!stored?.thumbnail,
  };
  if (toProve.length) {
    if (thumbnailBlob) {
      const url = await publishThumbnail(entry, thumbnailBlob);
      if (url) { status.thumbnail = true; def.thumbnail = url; }
    }
    await publishStatus(entry, status);
  }
  const mine = engines[activeEngine()];
  const error = mine && !mine.ok && !mine.skipped ? stageError(mine.stage || 'render', `${activeEngine() === 'webgl' ? 'WebGL' : 'WebGPU'}: ${mine.error}`) : null;
  if (error) error.reported = true;
  return { status, error };
}

// ── Loading ─────────────────────────────────────────────────────────────────

const listEntries = new Map(); // type → list entry
const loaded = new Map();      // type → { rev, def }
const loading = new Map();     // type → Promise<def>
const failed = new Map();      // type → { rev, def } — not retried until the install changes

async function fetchInstalledEffect(entry) {
  let source;
  try {
    const response = await fetch(`${entry.url}?v=${entry.modified_at}`);
    if (!response.ok) throw new Error(`fetch failed (${response.status})`);
    source = await response.text();
  } catch (error) {
    // Says nothing about the package, so it is not published as its status.
    throw stageError('fetch', error?.message || String(error));
  }
  try {
    const def = await prepareEffect(source, entry);
    await loadTextures(def, entry);
    const { status, error } = await checkEffect(def, entry);
    def.status = status;
    if (error) throw error;
    return def;
  } catch (error) {
    // A package that never reached the proof still reports why, so an agent can
    // read it from GET /api/effects/local without the user relaying it. A proof
    // failure was reported by checkEffect already.
    const stored = storedStatus(entry);
    if (!error.reported && !(stored && !stored.ok && stored.error === error.message)) {
      await publishStatus(entry, {
        rev: entry.modified_at, ok: false, error: error.message, stage: error.stage || 'load',
        engines: {}, warnings: [], checkedOn: activeEngine(), thumbnail: false,
      });
    }
    throw error;
  }
}

function basePlaceholder(entry) {
  return {
    id: localType(entry.id),
    localId: entry.id,
    name: entry.id,
    description: '',
    group: GROUP,
    renderer: null,
    renderers: [],
    animated: false,
    params: [],
    textures: [],
    isLocal: true,
    rev: entry.modified_at,
    packaged: !!entry.packaged,
    thumbnail: entry.thumbnail || null,
    status: entry.status || null,
  };
}

// What a package is before its code has loaded: name, engine and params from the
// metadata it published last time, no shading. The chain skips it until ready.
function placeholderDef(entry) {
  const meta = entry.metadata;
  const type = localType(entry.id);
  const def = {
    ...basePlaceholder(entry),
    ...(meta ? {
      name: meta.name || entry.id,
      description: meta.description || '',
      renderer: meta.renderer || null,
      renderers: Array.isArray(meta.renderers) ? [...meta.renderers] : (meta.renderer ? [meta.renderer] : []),
      animated: meta.animated !== false,
      params: (meta.params || []).map((p) => {
        const { keyframable: _keyframable, ...param } = p;
        return param;
      }),
    } : {}),
    ready: false,
    lazy: true,
    error: null,
    load: () => ensureLocalEffectLoaded(type),
  };
  if (Array.isArray(meta?.scopes)) def.scopes = [...meta.scopes];
  return def;
}

function failedDef(entry, error) {
  const base = entry.metadata ? placeholderDef(entry) : basePlaceholder(entry);
  return { ...base, lazy: false, ready: false, load: undefined, error: String(error?.message || error) };
}

// GPU memory of a revision the editor no longer uses: each engine's texture of
// each package image (made on first use by adjustmentEffects / …Nodes).
function releaseTextures(def) {
  for (const spec of def?.textures || []) {
    spec.glTexture?.dispose();
    spec.gpuTexture?.dispose();
    spec.glTexture = null;
    spec.gpuTexture = null;
  }
}

export function ensureLocalEffectLoaded(type) {
  const entry = listEntries.get(type);
  if (!entry) return Promise.resolve(null);
  const cached = loaded.get(type);
  if (cached && cached.rev === entry.modified_at) return Promise.resolve(cached.def);
  if (failed.get(type)?.rev === entry.modified_at) return Promise.resolve(failed.get(type).def);
  if (loading.has(type)) return loading.get(type);
  const load = fetchInstalledEffect(entry)
    .then((def) => {
      releaseTextures(loaded.get(type)?.def);
      loaded.set(type, { rev: entry.modified_at, def });
      failed.delete(type);
      upsertLocalEffect(def);
      publishMetadata(entry, def);
      return def;
    })
    .catch((error) => {
      console.warn(`[effects] Effect package "${entry.id}" did not load:`, error?.message || error);
      const def = failedDef(entry, error);
      failed.set(type, { rev: entry.modified_at, def });
      upsertLocalEffect(def);
      return def;
    })
    .finally(() => loading.delete(type));
  loading.set(type, load);
  return load;
}

// The error a stored check of this revision gives for THIS session's engine —
// or for the package as a whole, when it failed before any engine was tried.
function knownErrorHere(entry) {
  const stored = storedStatus(entry);
  if (!stored || stored.ok) return null;
  const mine = stored.engines?.[activeEngine()];
  if (mine && !mine.ok && mine.error) return `${activeEngine() === 'webgl' ? 'WebGL' : 'WebGPU'}: ${mine.error}`;
  return Object.keys(stored.engines || {}).length ? null : stored.error;
}

// An install nobody has checked on this machine yet — fresh from an agent, or
// carried in from another computer — is loaded (and so proven) right away, in
// the background, so its status is there for whoever asks.
const needsCheckHere = (entry) => {
  const stored = storedStatus(entry);
  if (!stored) return true;
  const result = stored.engines?.[activeEngine()];
  const renderers = Array.isArray(entry.metadata?.renderers) ? entry.metadata.renderers : [entry.metadata?.renderer];
  return renderers.includes(activeEngine()) && (!result || (!result.ok && !result.error && result.skipped));
};

export async function loadLocalEffects() {
  const response = await fetch(`${API_BASE}/effects/local`);
  if (!response.ok) throw new Error(`Failed to list effect packages (${response.status})`);
  const { effects } = await response.json();
  listEntries.clear();
  for (const entry of effects || []) listEntries.set(localType(entry.id), entry);
  for (const type of [...loaded.keys()]) {
    if (!listEntries.has(type)) { releaseTextures(loaded.get(type).def); loaded.delete(type); }
  }
  for (const type of [...failed.keys()]) if (!listEntries.has(type)) failed.delete(type);
  const defs = [];
  const background = [];
  for (const entry of effects || []) {
    const type = localType(entry.id);
    const cached = loaded.get(type);
    if (cached && cached.rev === entry.modified_at) { defs.push(cached.def); continue; }
    const broken = failed.get(type);
    if (broken && broken.rev === entry.modified_at) { defs.push(broken.def); continue; }
    // A check of this revision already says it cannot draw here: show that,
    // without loading it again to find out.
    const known = knownErrorHere(entry);
    if (known) {
      const def = failedDef(entry, known);
      failed.set(type, { rev: entry.modified_at, def });
      defs.push(def);
      continue;
    }
    defs.push(placeholderDef(entry));
    if (!entry.metadata?.params || needsCheckHere(entry)) background.push(type);
  }
  // After the list is registered, so the placeholders are what loads replace.
  if (background.length) queueMicrotask(() => { for (const type of background) ensureLocalEffectLoaded(type); });
  return defs;
}

export async function loadAndRegisterLocalEffects() {
  const defs = await loadLocalEffects();
  replaceLocalEffects(defs);
  return defs;
}

// ── Import / delete (Custom Library) ────────────────────────────────────────

async function uploadEffect(file, filename) {
  const form = new FormData();
  form.append('file', file, filename);
  const response = await fetch(`${API_BASE}/effects/local/import?filename=${encodeURIComponent(filename)}`, { method: 'POST', body: form });
  if (!response.ok) {
    let detail = `Import failed (${response.status})`;
    try { detail = (await response.json()).detail || detail; } catch { /* keep status */ }
    throw new Error(detail);
  }
  return (await response.json()).effect;
}

// Installs, then proves the package loads and draws on this editor's engine; a
// package that does not is removed again, so nothing broken stays installed.
export async function importLocalEffect(file) {
  const entry = await uploadEffect(file, file.name || 'effect.js');
  try {
    const def = await fetchInstalledEffect(entry);
    releaseTextures(loaded.get(localType(entry.id))?.def);
    loaded.set(localType(entry.id), { rev: entry.modified_at, def });
    failed.delete(localType(entry.id));
    await publishMetadata(entry, def);
    await loadAndRegisterLocalEffects();
    return def;
  } catch (error) {
    await deleteLocalEffect(entry.id).catch(() => {});
    throw error;
  }
}

export async function deleteLocalEffect(effectId) {
  const response = await fetch(`${API_BASE}/effects/local/${encodeURIComponent(effectId)}`, { method: 'DELETE' });
  if (!response.ok && response.status !== 404) throw new Error(`Delete failed (${response.status})`);
  await loadAndRegisterLocalEffects();
}
