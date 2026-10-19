// User-installed Advanced Transition packages. Like MotionFast modules, packages
// are executable renderers. They receive the real transition SDK (Three.js,
// shaders, render targets, scenes, geometry, media textures, and lifecycle), not a
// fixed list of animation presets.
import {
  ADVANCED_TRANSITION_MAX_DURATION,
  ADVANCED_TRANSITION_MIN_DURATION,
  ADVANCED_TRANSITION_PRESETS,
  replaceLocalAdvancedTransitionPresets,
  upsertLocalAdvancedTransitionPreset,
} from './advancedTransitions.js';
import * as transitionSdk from './transitionPackageSdk.js';
import { advancedTransitionMetadata } from './capabilityMetadata.js';
import { importModuleFromSource as importPackageModule, runStaticGate, stripCommentsAndStrings } from './packageGate.js';
import { packageAssetUrl } from './packageAssetUrls.js';

const API_BASE = import.meta.env?.VITE_API_BASE_URL || '/api';
const KEBAB_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FIELD_TYPES = new Set(['switch', 'range', 'number', 'select', 'text', 'textarea', 'color']);
const RENDERERS = new Set(['webgl', 'webgpu']);
const SDK_GLOBAL = '__GL_TRANSITION_SDK__';
globalThis[SDK_GLOBAL] = transitionSdk;

// Match MotionFast's import model: package code may import the app-provided SDK,
// while every other module import remains rejected. The rewrite happens only at
// load time; the original source remains portable inside the package.
function rewriteSdkImports(source) {
  let code = source.replace(
    /import\s*\{([^}]*)\}\s*from\s*['"]\.\/transition-sdk(?:\.js)?['"]\s*;?/g,
    (_, names) => `const {${names.replace(/\s+as\s+/g, ': ')}} = globalThis.${SDK_GLOBAL};`,
  );
  code = code.replace(
    /import\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s*from\s*['"]\.\/transition-sdk(?:\.js)?['"]\s*;?/g,
    (_, name) => `const ${name} = globalThis.${SDK_GLOBAL};`,
  );
  if (stripCommentsAndStrings(code).match(/(^|[\n;{])\s*import\s/)) {
    throw new Error("Only imports from './transition-sdk' are allowed; bundle every package function into transition.js.");
  }
  return code;
}

function importModuleFromSource(code) {
  return importPackageModule(code, 'Transition');
}

function validateOptionFields(descriptor, problems) {
  if (!descriptor.optionDefaults || typeof descriptor.optionDefaults !== 'object' || Array.isArray(descriptor.optionDefaults)) {
    problems.push('`optionDefaults` must be an object');
  }
  if (!Array.isArray(descriptor.optionFields)) {
    problems.push('`optionFields` must be an array');
    return;
  }
  const keys = new Set();
  for (const field of descriptor.optionFields) {
    if (!field || typeof field.key !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(field.key)) {
      problems.push('every option field needs a safe `key`');
      continue;
    }
    if (keys.has(field.key)) problems.push(`duplicate option field key "${field.key}"`);
    keys.add(field.key);
    if (typeof field.label !== 'string' || !field.label.trim()) problems.push(`option "${field.key}" needs a label`);
    if (!FIELD_TYPES.has(field.type)) problems.push(`option "${field.key}" has unsupported type "${field.type}"`);
    const initial = descriptor.optionDefaults?.[field.key];
    if (field.type === 'switch' && typeof initial !== 'boolean') problems.push(`switch "${field.key}" needs a boolean default`);
    if ((field.type === 'range' || field.type === 'number') && !Number.isFinite(initial)) {
      problems.push(`numeric option "${field.key}" needs a finite default`);
    }
    if (field.type === 'select') {
      const values = (field.options || []).map((option) => (typeof option === 'object' ? option.value : option));
      if (values.some((value) => typeof value !== 'string')) problems.push(`select "${field.key}" option values must be strings`);
      if (!values.length || !values.includes(initial)) problems.push(`select "${field.key}" needs options containing its default`);
    }
    if ((field.type === 'text' || field.type === 'textarea' || field.type === 'color') && typeof initial !== 'string') {
      problems.push(`${field.type} option "${field.key}" needs a string default`);
    }
  }
}

function validateMedia(descriptor, assetUrls, problems) {
  const knownAssets = new Set(Object.values(assetUrls));
  if (descriptor.audio) {
    if (!knownAssets.has(descriptor.audio.url)) problems.push('`audio.url` must reference TRANSITION_ASSETS');
    if (!Number.isFinite(descriptor.audio.trimStart) || !Number.isFinite(descriptor.audio.trimEnd)
      || descriptor.audio.trimStart < 0 || descriptor.audio.trimEnd <= descriptor.audio.trimStart) {
      problems.push('`audio.trimStart`/`trimEnd` must define a positive finite range');
    }
    if (descriptor.audio.volume != null && !Number.isFinite(descriptor.audio.volume)) problems.push('`audio.volume` must be finite');
  }
  if (descriptor.media != null && !Array.isArray(descriptor.media)) problems.push('`media` must be an array');
  const ids = new Set();
  for (const media of descriptor.media || []) {
    if (!media || typeof media.id !== 'string' || !KEBAB_ID_RE.test(media.id)) {
      problems.push('every media source needs a kebab-case `id`');
      continue;
    }
    if (ids.has(media.id)) problems.push(`duplicate media id "${media.id}"`);
    ids.add(media.id);
    if (media.type !== 'video' && media.type !== 'image') problems.push(`media "${media.id}" type must be video or image`);
    if (!knownAssets.has(media.src)) problems.push(`media "${media.id}" src must reference TRANSITION_ASSETS`);
    if (media.type === 'video') {
      if (media.trimStart != null && (!Number.isFinite(media.trimStart) || media.trimStart < 0)) {
        problems.push(`media "${media.id}" trimStart must be a positive finite number`);
      }
      if (media.trimEnd != null && (!Number.isFinite(media.trimEnd) || media.trimEnd <= (media.trimStart || 0))) {
        problems.push(`media "${media.id}" trimEnd must be after trimStart`);
      }
    }
  }
}

function validateShape(module, assetUrls) {
  const descriptor = module?.default;
  if (!descriptor || typeof descriptor !== 'object') {
    throw new Error('Transition must default-export its descriptor object.');
  }
  const problems = [];
  if (typeof descriptor.id !== 'string' || !KEBAB_ID_RE.test(descriptor.id)) problems.push('`id` must be kebab-case');
  if (typeof descriptor.name !== 'string' || !descriptor.name.trim()) problems.push('`name` must be non-empty');
  if (typeof descriptor.description !== 'string' || !descriptor.description.trim()) problems.push('`description` must be non-empty');
  if (descriptor.defaultDuration != null && (
    !Number.isFinite(descriptor.defaultDuration)
    || descriptor.defaultDuration < ADVANCED_TRANSITION_MIN_DURATION
    || descriptor.defaultDuration > ADVANCED_TRANSITION_MAX_DURATION
  )) {
    problems.push(`\`defaultDuration\` must be a finite number from ${ADVANCED_TRANSITION_MIN_DURATION} to ${ADVANCED_TRANSITION_MAX_DURATION} seconds`);
  }
  if (descriptor.renderer != null && !RENDERERS.has(descriptor.renderer)) {
    problems.push('`renderer` must be "webgl" or "webgpu"');
  }
  if (typeof descriptor.createInstance !== 'function') problems.push('`createInstance(context)` function is required');
  if (descriptor.apply != null) problems.push('legacy `apply()` packages are no longer supported; use createInstance()');
  validateOptionFields(descriptor, problems);
  validateMedia(descriptor, assetUrls, problems);
  if (problems.length) throw new Error(`Invalid transition: ${problems.join('; ')}.`);
  return descriptor;
}

function rawAssetMap(entry) {
  return Object.fromEntries((entry.assets || []).map((rel) => [
    rel,
    `${entry.assetBase}${encodeURI(rel)}?v=${entry.modified_at}`,
  ]));
}

// the map a loaded package runs with: a page without a server maps the URLs to its own files
// (packageAssetUrls.js); the app uses them as they are
async function buildAssetMap(entry) {
  const raw = rawAssetMap(entry);
  return Object.fromEntries(await Promise.all(Object.entries(raw).map(async ([rel, url]) => [rel, await packageAssetUrl(url)])));
}

const THUMBNAIL_RE = /^thumbnail\.(png|jpe?g|webp|gif|svg)$/i;
const PREVIEW_RE = /^preview\.(mp4|webm|mov)$/i;
function findPreviewAssets(descriptor, assets) {
  const found = {};
  for (const [rel, url] of Object.entries(assets)) {
    const base = rel.split('/').pop();
    if (!descriptor.thumbnail && !found.thumbnail && THUMBNAIL_RE.test(base)) found.thumbnail = url;
    if (!descriptor.previewVideo && !found.previewVideo && PREVIEW_RE.test(base)) found.previewVideo = url;
  }
  return found;
}

/*
 * WHICH ENGINE THIS PACKAGE IS FOR — the declaration first, the evidence second.
 *
 * A package's shading is GLSL or TSL and only one renderer builds each, so the
 * question "will this draw here" has an answer long before anything renders. A
 * descriptor that says `renderer` is taken at its word. One that does not gets
 * read: calling `createGlslMaterialForWebgl` is not a hint about the engine, it
 * IS the engine, and the same goes for `createShaderMaterial`. Packages predate
 * the field, so inferring keeps them classified correctly without a reissue.
 *
 * Both or neither returns null — a package with no custom shading, or one whose
 * shading is built some other way, has nothing here to pin it down, and guessing
 * would be worse than saying so: null means "no claim", and the SDK still refuses
 * the wrong material with a message at the moment it is built.
 */
export function resolveRenderer(descriptor, source) {
  if (RENDERERS.has(descriptor.renderer)) return descriptor.renderer;
  const code = stripCommentsAndStrings(source);
  const glsl = /\bcreateGlslMaterialForWebgl\b/.test(code);
  const tsl = /\bcreateShaderMaterial\b/.test(code);
  if (glsl === tsl) return null;
  return glsl ? 'webgl' : 'webgpu';
}

async function prepareTransition(source, assets = {}) {
  const violations = runStaticGate(source);
  if (violations.length) throw new Error(`Transition uses APIs outside the package contract: ${violations.join(', ')}.`);
  const code = `const TRANSITION_ASSETS = Object.freeze(${JSON.stringify(assets)});\n${rewriteSdkImports(source)}`;
  const descriptor = validateShape(await importModuleFromSource(code), assets);
  return { ...descriptor, renderer: resolveRenderer(descriptor, source) };
}

async function fetchInstalledTransition(entry) {
  const response = await fetch(`${entry.url}?v=${entry.modified_at}`);
  if (!response.ok) throw new Error(`fetch failed (${response.status})`);
  const assets = await buildAssetMap(entry);
  const descriptor = await prepareTransition(await response.text(), assets);
  if (descriptor.id !== entry.id) throw new Error(`Stored id "${entry.id}" does not match module id "${descriptor.id}".`);
  const loaded = {
    ...descriptor,
    ...findPreviewAssets(descriptor, assets),
    type: `local:${descriptor.id}`,
    category: 'advanced',
    source: 'local',
    localId: descriptor.id,
    packaged: !!entry.packaged,
    rev: entry.modified_at,
    assetMap: assets,
  };
  const metadata = advancedTransitionMetadata(loaded);
  if (JSON.stringify(entry.metadata || null) !== JSON.stringify(metadata)) {
    try {
      const metadataResponse = await fetch(`${API_BASE}/advanced-transitions/local/${encodeURIComponent(entry.id)}/metadata`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(metadata),
      });
      if (!metadataResponse.ok) throw new Error(`metadata sync failed (${metadataResponse.status})`);
    } catch (error) {
      console.warn(`[transitions] Could not publish capabilities for local transition "${entry.id}":`, error?.message || error);
    }
  }
  return loaded;
}

/*
 * LAZY REGISTRATION. The list endpoint carries each package's published
 * capabilities (`metadata`, written by fetchInstalledTransition the first time
 * the package was evaluated) and its asset list, which is everything the picker
 * and the inspector show. So a package is registered as a placeholder built
 * from that, and its source is fetched + evaluated only on first use:
 *   - getAdvancedTransitionPreset(type) calls `load()` when the project
 *     references it (the Player asks for every transition it draws);
 *   - the placeholder's createInstance awaits the same load, so a frame that
 *     arrives first simply waits (the runtime already handles async instances);
 *   - once loaded the full descriptor replaces the placeholder in the registry
 *     and listeners re-render.
 * A package without published metadata (installed before capabilities existed)
 * is evaluated eagerly this once — that publishes its metadata for next time.
 * Full descriptors are cached per (id, rev), so re-listing after an import or
 * delete never re-evaluates an unchanged package.
 */
const fullDescriptors = new Map(); // type → { rev, descriptor }
const fullLoads = new Map();       // type → Promise<descriptor>
const listEntries = new Map();     // type → list entry
// A load that FAILED is remembered for a while: every lookup of a broken package
// used to start another fetch (and another unhandled rejection). Within the
// window the same rejection is handed back without a request; a re-imported
// package (new modified_at) retries at once.
const fullFailures = new Map();    // type → { rev, at, error }
const FAILED_LOAD_RETRY_MS = 30000;

function localType(entry) { return `local:${entry.id}`; }

export function ensureLocalAdvancedTransitionLoaded(type) {
  const entry = listEntries.get(type);
  if (!entry) return Promise.resolve(null);
  const cached = fullDescriptors.get(type);
  if (cached && cached.rev === entry.modified_at) return Promise.resolve(cached.descriptor);
  if (fullLoads.has(type)) return fullLoads.get(type);
  const failed = fullFailures.get(type);
  if (failed && failed.rev === entry.modified_at && Date.now() - failed.at < FAILED_LOAD_RETRY_MS) {
    return Promise.reject(failed.error);
  }
  const load = fetchInstalledTransition(entry).then((descriptor) => {
    fullDescriptors.set(type, { rev: entry.modified_at, descriptor });
    fullLoads.delete(type);
    fullFailures.delete(type);
    upsertLocalAdvancedTransitionPreset(descriptor);
    return descriptor;
  }).catch((error) => {
    fullLoads.delete(type);
    fullFailures.set(type, { rev: entry.modified_at, at: Date.now(), error });
    console.warn(`[transitions] Local transition "${entry.id}" failed to load (no retry for ${FAILED_LOAD_RETRY_MS / 1000}s):`, error?.message || error);
    throw error;
  });
  fullLoads.set(type, load);
  return load;
}

// Resolves when every full load requested so far has settled (used before an
// export so a referenced package is never still a placeholder on frame 0).
export function settleRequestedLocalAdvancedTransitions() {
  return Promise.allSettled([...fullLoads.values()]).then(() => undefined);
}

function lazyPreset(entry) {
  const meta = entry.metadata;
  const assets = rawAssetMap(entry);
  const type = localType(entry);
  return {
    id: entry.id,
    name: meta.name || entry.id,
    description: meta.description || '',
    defaultDuration: Number.isFinite(meta.defaultDuration) ? meta.defaultDuration : undefined,
    optionDefaults: meta.optionDefaults || {},
    optionFields: meta.optionFields || [],
    renderer: meta.renderer === 'webgl' || meta.renderer === 'webgpu' ? meta.renderer : null,
    ...findPreviewAssets({}, assets),
    type,
    category: 'advanced',
    source: 'local',
    localId: entry.id,
    packaged: !!entry.packaged,
    rev: entry.modified_at,
    assetMap: assets,
    lazy: true,
    // The registry's lazy trigger is fire-and-forget: a failure was logged by
    // the load itself and must not surface as an unhandled rejection per lookup.
    load: () => ensureLocalAdvancedTransitionLoaded(type).catch(() => null),
    createInstance: (context) => ensureLocalAdvancedTransitionLoaded(type)
      .then((descriptor) => descriptor.createInstance(context)),
  };
}

export async function loadLocalAdvancedTransitions() {
  const response = await fetch(`${API_BASE}/advanced-transitions/local`);
  if (!response.ok) throw new Error(`Failed to list local transitions (${response.status})`);
  const { transitions } = await response.json();
  listEntries.clear();
  for (const entry of transitions || []) listEntries.set(localType(entry), entry);
  for (const type of [...fullDescriptors.keys()]) if (!listEntries.has(type)) fullDescriptors.delete(type);
  const loaded = [];
  for (const entry of transitions || []) {
    const type = localType(entry);
    const cached = fullDescriptors.get(type);
    if (cached && cached.rev === entry.modified_at) { loaded.push(cached.descriptor); continue; }
    if (entry.metadata && typeof entry.metadata === 'object' && entry.metadata.optionFields) {
      loaded.push(lazyPreset(entry));
      continue;
    }
    try {
      const descriptor = await fetchInstalledTransition(entry);
      fullDescriptors.set(type, { rev: entry.modified_at, descriptor });
      loaded.push(descriptor);
    } catch (error) { console.warn(`[transitions] Skipping local transition "${entry.id}":`, error?.message || error); }
  }
  return loaded;
}

export async function loadAndRegisterLocalAdvancedTransitions() {
  const loaded = await loadLocalAdvancedTransitions();
  replaceLocalAdvancedTransitionPresets(loaded);
  return loaded;
}

async function uploadTransition(file, filename) {
  const form = new FormData();
  form.append('file', file, filename);
  const response = await fetch(`${API_BASE}/advanced-transitions/local/import?filename=${encodeURIComponent(filename)}`, {
    method: 'POST',
    body: form,
  });
  if (!response.ok) {
    let detail = `Import failed (${response.status})`;
    try { detail = (await response.json()).detail || detail; } catch { /* keep status */ }
    throw new Error(detail);
  }
  return (await response.json()).transition;
}

async function isPackage(file) {
  if (/\.(zip|gltransition)$/i.test(file.name || '')) return true;
  const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  return head[0] === 0x50 && head[1] === 0x4b;
}

export async function importLocalAdvancedTransition(file) {
  let entry;
  if (await isPackage(file)) {
    entry = await uploadTransition(file, file.name || 'transition.gltransition');
    try {
      const descriptor = await fetchInstalledTransition(entry);
      if (Object.prototype.hasOwnProperty.call(ADVANCED_TRANSITION_PRESETS, descriptor.name)) {
        throw new Error(`Transition name "${descriptor.name}" is already used by a built-in transition.`);
      }
      await loadAndRegisterLocalAdvancedTransitions();
      return descriptor;
    } catch (error) {
      await deleteLocalAdvancedTransition(entry.id).catch(() => {});
      throw error;
    }
  }

  const source = await file.text();
  if (!source.trim()) throw new Error('The selected file is empty.');
  const descriptor = await prepareTransition(source, {});
  if (Object.prototype.hasOwnProperty.call(ADVANCED_TRANSITION_PRESETS, descriptor.name)) {
    throw new Error(`Transition name "${descriptor.name}" is already used by a built-in transition.`);
  }
  await uploadTransition(new File([source], `${descriptor.id}.js`, { type: 'text/javascript' }), `${descriptor.id}.js`);
  await loadAndRegisterLocalAdvancedTransitions();
  return { ...descriptor, type: `local:${descriptor.id}`, source: 'local', localId: descriptor.id };
}

export async function deleteLocalAdvancedTransition(transitionId) {
  const response = await fetch(`${API_BASE}/advanced-transitions/local/${encodeURIComponent(transitionId)}`, { method: 'DELETE' });
  if (!response.ok && response.status !== 404) throw new Error(`Delete failed (${response.status})`);
  await loadAndRegisterLocalAdvancedTransitions();
}
