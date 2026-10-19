// Local (user-imported) MotionFast templates.
//
// A local template is a plain .js module written against the same contract as the
// built-in templates (see MOTIONFAST_TEMPLATE_GUIDE.md): metadata + defaultParams +
// fields + getDuration + draw/createInstance, importing helpers only from './mtl'.
// Files are stored by the backend under MEDIA_DIR/motion-templates and loaded here:
//   1. static gate — reject anything outside the template contract surface
//      (network, DOM, timers, wall clock, dynamic code) so every local template
//      stays portable to the future sandboxed cloud runtime;
//   2. './mtl' imports are rewritten to read from the injected helper object;
//   3. the module is imported from a Blob URL and its shape is validated;
//   4. on user import (not on startup load) frames are also rendered twice to
//      verify the template is a pure function of time.
//
// The ORIGINAL source is what gets uploaded/stored, so a local template file can be
// shared and re-imported anywhere; the rewrite happens only at load time.
import * as mtl from './mtl';
import { isFieldKeyframable } from '../motionKf';
import { motionTemplateMetadata } from '../capabilityMetadata';

const API_BASE = import.meta.env?.VITE_API_BASE_URL || '/api';

const MTL_GLOBAL = '__GL_MTL__';
globalThis[MTL_GLOBAL] = mtl;

const KEBAB_ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// Identifiers a template must never reference. This is the same list the cloud
// review static gate uses — templates that pass it only touch ctx/params/time/mtl,
// which keeps them reviewable and sandbox-compatible.
const FORBIDDEN_TOKENS = [
  ['fetch', 'network access'],
  ['XMLHttpRequest', 'network access'],
  ['WebSocket', 'network access'],
  ['EventSource', 'network access'],
  ['importScripts', 'dynamic code loading'],
  ['require', 'module loading'],
  ['eval', 'dynamic code'],
  ['Function', 'dynamic code'],
  ['document', 'DOM access'],
  ['window', 'DOM access'],
  ['globalThis', 'global access'],
  ['localStorage', 'storage access'],
  ['sessionStorage', 'storage access'],
  ['indexedDB', 'storage access'],
  ['navigator', 'browser APIs'],
  ['process', 'process access'],
  ['Worker', 'worker spawning'],
  ['postMessage', 'messaging'],
  ['setTimeout', 'timers (templates are pure functions of timeSec)'],
  ['setInterval', 'timers (templates are pure functions of timeSec)'],
  ['requestAnimationFrame', 'timers (templates are pure functions of timeSec)'],
  ['Date', 'wall-clock time (derive everything from timeSec)'],
  ['performance', 'wall-clock time (derive everything from timeSec)'],
];

// Blank out comments and string/template-literal contents so the token gate only
// sees real code identifiers (a param default of "window cleaner" must not trip it).
function stripCommentsAndStrings(src) {
  let out = '';
  let mode = null; // "'" | '"' | '`' | '//' | '/*'
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const d = src[i + 1];
    if (!mode) {
      if (c === "'" || c === '"' || c === '`') { mode = c; out += c; continue; }
      if (c === '/' && d === '/') { mode = '//'; i++; continue; }
      if (c === '/' && d === '*') { mode = '/*'; i++; continue; }
      out += c;
      continue;
    }
    if (mode === '//') { if (c === '\n') { mode = null; out += c; } continue; }
    if (mode === '/*') { if (c === '*' && d === '/') { mode = null; i++; } continue; }
    if (c === '\\') { i++; continue; }
    if (c === mode) { mode = null; out += c; }
  }
  return out;
}

function runStaticGate(source) {
  const code = stripCommentsAndStrings(source);
  const violations = [];
  for (const [token, why] of FORBIDDEN_TOKENS) {
    if (new RegExp(`\\b${token}\\b`).test(code)) violations.push(`"${token}" (${why})`);
  }
  if (/\bMath\s*\.\s*random\b/.test(code)) {
    violations.push('"Math.random" (use makeSeededRandom/noise from mtl for deterministic randomness)');
  }
  if (/\bimport\s*\(/.test(code)) violations.push('dynamic "import()" (dynamic code loading)');
  return violations;
}

// Rewrite `import { a, b as c } from './mtl'` / `import * as m from './mtl'` to read
// from the injected helper object; any other import is a contract violation.
function rewriteMtlImports(source) {
  let code = source.replace(
    /import\s*\{([^}]*)\}\s*from\s*['"]\.\/mtl(?:\.js)?['"]\s*;?/g,
    (_, names) => `const {${names.replace(/\s+as\s+/g, ': ')}} = globalThis.${MTL_GLOBAL};`,
  );
  code = code.replace(
    /import\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s+from\s*['"]\.\/mtl(?:\.js)?['"]\s*;?/g,
    (_, name) => `const ${name} = globalThis.${MTL_GLOBAL};`,
  );
  const leftover = stripCommentsAndStrings(code).match(/(^|[\n;{])\s*import\s/);
  if (leftover) {
    throw new Error("Only imports from './mtl' are allowed — a template must be a single self-contained module.");
  }
  return code;
}

async function importModuleFromSource(code) {
  const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  try {
    return await import(/* @vite-ignore */ url);
  } catch (err) {
    throw new Error(`Template module failed to load: ${err?.message || err}`);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function validateShape(mod) {
  const t = mod?.default;
  if (!t || typeof t !== 'object') {
    throw new Error('Template must default-export its descriptor object (see the module contract).');
  }
  const problems = [];
  if (typeof t.id !== 'string' || !KEBAB_ID_RE.test(t.id)) problems.push('`id` must be a kebab-case string');
  if (typeof t.name !== 'string' || !t.name.trim()) problems.push('`name` must be a non-empty string');
  if (typeof t.category !== 'string' || !t.category.trim()) problems.push('`category` must be a non-empty string');
  if (!t.defaultParams || typeof t.defaultParams !== 'object') problems.push('`defaultParams` must be an object');
  if (!Array.isArray(t.fields) || t.fields.some((f) => !f || typeof f.key !== 'string' || typeof f.type !== 'string')) {
    problems.push('`fields` must be an array of { key, label, type, ... } objects');
  }
  if (typeof t.getDuration !== 'function') problems.push('`getDuration(params)` function is required');
  if (typeof t.draw !== 'function' && typeof t.createInstance !== 'function') {
    problems.push('either `draw()` or `createInstance()` is required');
  }
  if (problems.length) throw new Error(`Invalid template: ${problems.join('; ')}.`);

  let duration;
  try {
    duration = t.getDuration(t.defaultParams);
  } catch (err) {
    throw new Error(`getDuration(defaultParams) threw: ${err?.message || err}`);
  }
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('getDuration(defaultParams) must return a positive number of seconds.');
  }
  return t;
}

function renderFramePixels(template, timeSec, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const params = template.defaultParams || {};
  if (typeof template.createInstance === 'function') {
    const instance = template.createInstance(params);
    instance.seek(timeSec);
    instance.render(ctx, { width, height });
  } else {
    template.draw(ctx, { width, height, timeSec, params });
  }
  return ctx.getImageData(0, 0, width, height).data;
}

// A template must paint the identical frame for the same timeSec, from a fresh
// instance, regardless of seek order. All renders run synchronously in one tick so
// async image loading cannot make the comparison flaky (images are consistently
// not-yet-loaded in every render).
function runRenderChecks(template) {
  const W = 192;
  const H = 108;
  const duration = template.getDuration(template.defaultParams);
  const t1 = duration * 0.4;
  const fail = () => {
    throw new Error(
      'Template is not deterministic: rendering the same time twice produced different frames. '
      + 'Derive everything from timeSec/params and use the seeded helpers from mtl for randomness.',
    );
  };
  let first;
  let repeat;
  let afterSeek;
  try {
    first = renderFramePixels(template, t1, W, H);
    repeat = renderFramePixels(template, t1, W, H);          // consecutive repeat
    renderFramePixels(template, duration * 0.85, W, H);
    afterSeek = renderFramePixels(template, t1, W, H);       // out-of-order seek
  } catch (err) {
    throw new Error(`Template threw while rendering: ${err?.message || err}`);
  }
  for (let i = 0; i < first.length; i++) {
    if (first[i] !== repeat[i] || first[i] !== afterSeek[i]) fail();
  }
}

// Rel-path → served URL map for a packaged template's assets/ folder. Injected
// into the module as the frozen `TEMPLATE_ASSETS` constant, so templates write
// e.g. getMotionImage(TEMPLATE_ASSETS['photo.jpg']).
function buildAssetMap(entry) {
  const map = {};
  for (const rel of entry.assets || []) {
    map[rel] = `${entry.assetBase}${encodeURI(rel)}?v=${entry.modified_at}`;
  }
  return map;
}

// Font assets (ttf/otf/woff/woff2) register automatically as a FontFace whose
// family is the filename without extension, so templates can use it in setFont.
const registeredFontUrls = new Set();
function registerFontAssets(assetMap) {
  for (const [rel, url] of Object.entries(assetMap)) {
    if (!/\.(ttf|otf|woff2?)$/i.test(rel) || registeredFontUrls.has(url)) continue;
    registeredFontUrls.add(url);
    try {
      const family = rel.split('/').pop().replace(/\.[^.]+$/, '');
      const face = new FontFace(family, `url("${url}")`);
      document.fonts.add(face);
      face.load().catch(() => {});
    } catch { /* ignore malformed font files */ }
  }
}

// Gallery preview art for a packaged template, by convention: an asset named
// `thumbnail.*` becomes the card's still and `preview.*` the clip played on hover
// (MotionPanel). Zipping the two files in is the whole opt-in — no manifest, no
// code. A template that assigns `thumbnail`/`previewVideo` itself (e.g. from
// TEMPLATE_ASSETS under different names) keeps its own choice.
const THUMB_RE = /^thumbnail\.(png|jpe?g|webp|gif|svg)$/i;
const PREVIEW_VIDEO_RE = /^preview\.(mp4|webm|mov)$/i;
function findPreviewAssets(template, assetMap) {
  const out = {};
  for (const [rel, url] of Object.entries(assetMap)) {
    const base = rel.split('/').pop();
    if (!template.thumbnail && !out.thumbnail && THUMB_RE.test(base)) out.thumbnail = url;
    if (!template.previewVideo && !out.previewVideo && PREVIEW_VIDEO_RE.test(base)) out.previewVideo = url;
  }
  return out;
}

// Gate + rewrite + inject assets + import + shape-validate one source string.
async function prepareTemplate(source, assetMap = {}) {
  const violations = runStaticGate(source);
  if (violations.length) {
    throw new Error(`Template uses APIs outside the template contract: ${violations.join(', ')}.`);
  }
  const code = `const TEMPLATE_ASSETS = Object.freeze(${JSON.stringify(assetMap)});\n${rewriteMtlImports(source)}`;
  const mod = await importModuleFromSource(code);
  return validateShape(mod);
}

async function fetchInstalledTemplate(entry) {
  const srcRes = await fetch(`${entry.url}?v=${entry.modified_at}`);
  if (!srcRes.ok) throw new Error(`fetch failed (${srcRes.status})`);
  const assetMap = buildAssetMap(entry);
  registerFontAssets(assetMap);
  const template = await prepareTemplate(await srcRes.text(), assetMap);
  const loaded = {
    ...template,
    ...findPreviewAssets(template, assetMap),
    source: 'local',
    localId: entry.id,
    packaged: !!entry.packaged,
    rev: entry.modified_at,
  };
  const metadata = motionTemplateMetadata(loaded, isFieldKeyframable);
  if (JSON.stringify(entry.metadata || null) !== JSON.stringify(metadata)) {
    try {
      const response = await fetch(`${API_BASE}/motion-templates/local/${encodeURIComponent(entry.id)}/metadata`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(metadata),
      });
      if (!response.ok) throw new Error(`metadata sync failed (${response.status})`);
    } catch (error) {
      console.warn(`[motion] Could not publish capabilities for local template "${entry.id}":`, error?.message || error);
    }
  }
  return loaded;
}

// Evaluated templates, kept per id while their install is unchanged (same
// modified_at). Re-listing — the MotionFast tab opening, an API edit reloading
// the project — then costs one list request instead of re-fetching and
// re-evaluating every template. A template that failed is not retried until
// its file changes, so a broken install does not cost a fetch per re-list.
const loadedById = new Map();   // id → { rev, template }
const failedRevById = new Map(); // id → rev that failed

export async function loadLocalTemplates() {
  const res = await fetch(`${API_BASE}/motion-templates/local`);
  if (!res.ok) throw new Error(`Failed to list local templates (${res.status})`);
  const { templates } = await res.json();
  const out = [];
  const listed = new Set();
  for (const entry of templates || []) {
    listed.add(entry.id);
    const cached = loadedById.get(entry.id);
    if (cached && cached.rev === entry.modified_at) { out.push(cached.template); continue; }
    if (failedRevById.get(entry.id) === entry.modified_at) continue;
    try {
      const template = await fetchInstalledTemplate(entry);
      loadedById.set(entry.id, { rev: entry.modified_at, template });
      failedRevById.delete(entry.id);
      out.push(template);
    } catch (err) {
      failedRevById.set(entry.id, entry.modified_at);
      console.warn(`[motion] Skipping local template "${entry.id}":`, err?.message || err);
    }
  }
  for (const id of [...loadedById.keys()]) if (!listed.has(id)) loadedById.delete(id);
  for (const id of [...failedRevById.keys()]) if (!listed.has(id)) failedRevById.delete(id);
  return out;
}

async function uploadLocalTemplate(file, filename) {
  const form = new FormData();
  form.append('file', file, filename);
  const res = await fetch(`${API_BASE}/motion-templates/local/import?filename=${encodeURIComponent(filename)}`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) {
    let detail = `Import failed (${res.status})`;
    try { detail = (await res.json()).detail || detail; } catch { /* keep default */ }
    throw new Error(detail);
  }
  return (await res.json()).template;
}

async function isZipFile(file) {
  if (/\.(zip|glmotion)$/i.test(file.name || '')) return true;
  const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  return head[0] === 0x50 && head[1] === 0x4b; // "PK"
}

// Full import pipeline for a user-picked file. Bare .js is validated (gate, shape,
// render determinism) before upload. A .zip package is structurally validated and
// extracted by the backend first, then validated here against its real asset URLs —
// on any failure the install is rolled back. Re-importing the same id updates it.
export async function importLocalTemplateFile(file, builtinIds) {
  if (await isZipFile(file)) {
    const entry = await uploadLocalTemplate(file, file.name?.endsWith('.glmotion') ? file.name : (file.name || 'template.zip'));
    try {
      if (builtinIds.has(entry.id)) {
        throw new Error(`Template id "${entry.id}" is already used by a built-in template — pick a different id.`);
      }
      const template = await fetchInstalledTemplate(entry);
      runRenderChecks(template);
      return { id: template.id, name: template.name };
    } catch (err) {
      await deleteLocalTemplateFile(entry.id).catch(() => {});
      throw err;
    }
  }

  const source = await file.text();
  if (!source.trim()) throw new Error('The selected file is empty.');
  const template = await prepareTemplate(source, {});
  runRenderChecks(template);
  if (builtinIds.has(template.id)) {
    throw new Error(`Template id "${template.id}" is already used by a built-in template — pick a different id.`);
  }
  await uploadLocalTemplate(new File([source], `${template.id}.js`, { type: 'text/javascript' }), `${template.id}.js`);
  return { id: template.id, name: template.name };
}

export async function deleteLocalTemplateFile(templateId) {
  const res = await fetch(`${API_BASE}/motion-templates/local/${encodeURIComponent(templateId)}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) throw new Error(`Delete failed (${res.status})`);
}
