/*
 * GreenLight Motion Engine — where the engine's files come from when there is no backend.
 *
 * The editor's code asks the GreenLight Dash backend for things: lists of installed effect,
 * transition and template packages and fonts (`/api/...`), board media (`/media/...`), the
 * bundled HDR environments (`/hdr/...`), the 3D model presets (kept out of the bundle, see
 * vite.motion-engine.config.js). In a double-clicked page or a Claude artifact none of those
 * exist, so the engine answers them itself:
 *
 * - `/api/...` lists answer empty, every other `/api/` call a quiet 404 — the editor's own catch
 *   paths take it from there. Except PLUGINS: effect and transition packages the page carries as
 *   assets (`asset:plugins/effects/<id>.js` or `<id>/effect.js`, `asset:plugins/transitions/<id>.js`
 *   or `<id>/transition.js`) are listed exactly as GreenLight Dash lists installed ones, so a
 *   project's `local:<id>` effects and transitions load, prove and draw through the editor's own
 *   code. What each package's proof reported is kept for pluginStatus(). A packaged one's own files
 *   (`<id>/assets/…`: an effect's `textures`, a transition's TRANSITION_ASSETS) load from the page's
 *   assets too — the editor's loaders pass their URLs through packageAssetUrls.js, which maps
 *   `asset:plugins/<kind>/<id>/assets/<file>` to the file's blob: URL here.
 * - Asset references are resolved by the caller's ASSETS: an object map or a function, ref →
 *   Blob | ArrayBuffer | data:/blob:/https: URL | null. Images and videos are rewritten IN THE
 *   PROJECT to blob:/data: URLs (textures can't use local files); anything a loader fetches
 *   (models, HDRs) is answered through fetch. A ref nobody provides fails soft and is listed in
 *   missing(), so a CLI or an agent can supply it and load again.
 */

import { setPackageAssetResolver } from '../components/videoEditor/packageAssetUrls';

// What counts as an asset reference in a project (strings are rewritten when they start so).
const PROJECT_REF_PREFIXES = ['/media/', '/hdr/', 'asset:', 'motion-engine-unbundled:'];
const isProjectRef = (v) => typeof v === 'string' && PROJECT_REF_PREFIXES.some((p) => v.startsWith(p));
// Root paths that mean "the GreenLight Dash server" when a page on http(s) asks its own origin.
const SERVER_ROOTS = ['/api/', '/media/', '/hdr/'];

/*
 * The reference a request stands for, or null when it is an ordinary URL. Loaders (three's
 * FileLoader, so every model and HDR) fetch a Request, which has already resolved "/hdr/x.hdr"
 * against the page: on a double-clicked page that is file:///hdr/x.hdr. So: a file: URL outside
 * the page's own folder is a root path the page can't own → its path; a same-origin http(s) URL
 * under a server root → its path; a custom scheme (asset:, motion-engine-unbundled:) as is.
 */
function refFor(raw) {
  if (!raw) return null;
  if (isProjectRef(raw)) return raw;
  if (raw.startsWith('/') && !raw.startsWith('//')) return raw;
  let u;
  try { u = new URL(raw, window.location.href); } catch { return null; }
  if (u.protocol === 'file:') {
    const pageDir = window.location.protocol === 'file:' ? window.location.pathname.replace(/[^/]*$/, '') : null;
    return pageDir && u.pathname.startsWith(pageDir) ? null : decodeURIComponent(u.pathname);
  }
  if ((u.protocol === 'http:' || u.protocol === 'https:') && u.origin === window.location.origin
    && SERVER_ROOTS.some((r) => u.pathname.startsWith(r))) return u.pathname;
  return isProjectRef(u.href) ? u.href : null;
}

// The `/api/` lists the render path reads, in the shapes their callers expect.
const API_LISTS = {
  '/api/effects/local': { effects: [] },
  '/api/advanced-transitions/local': { transitions: [] },
  '/api/motion-templates/local': { templates: [] },
  '/api/fonts': { fonts: [] },
};

const nativeFetch = typeof window !== 'undefined' && window.fetch ? window.fetch.bind(window) : null;
let activeResolver = null;

// a packaged plugin's own files (an effect's textures, a transition's assets): the editor's loaders ask for
// `asset:plugins/<kind>/<id>/assets/<file>?v=<rev>`; the page answers with the file's URL from its resolver
setPackageAssetResolver((url) => {
  const ref = decodeURI(String(url).split('?')[0]);
  return ref.startsWith('asset:plugins/') && activeResolver ? activeResolver.url(ref) : null;
});
const missingRefs = new Set();

// ── plugins: the install lists, answered from the page's own assets ──
const PLUGIN_KINDS = {
  effects: { list: '/api/effects/local', key: 'effects', file: 'effect.js' },
  transitions: { list: '/api/advanced-transitions/local', key: 'transitions', file: 'transition.js' },
};
const PLUGIN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const pluginReports = new Map();   // `${kind}:${id}` → { kind, id, status?, metadata? }

function pluginEntries(keys, kind) {
  const { file } = PLUGIN_KINDS[kind];
  const prefix = `asset:plugins/${kind}/`;
  const entries = new Map();
  for (const key of keys) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    const flat = rest.match(/^([^/]+)\.js$/);
    const packaged = rest.match(/^([^/]+)\/(.+)$/);
    const id = (flat || packaged || [])[1];
    if (!id || !PLUGIN_ID.test(id)) continue;
    const entry = entries.get(id) || { id, packaged: false, url: null, assets: [] };
    if (flat && !entry.packaged) entry.url = key;
    if (packaged && packaged[2] === file) Object.assign(entry, { packaged: true, url: key });
    if (packaged && packaged[2].startsWith('assets/')) entry.assets.push(packaged[2].slice('assets/'.length));
    entries.set(id, entry);
  }
  return [...entries.values()].filter((e) => e.url).map((e) => ({
    id: e.id,
    packaged: e.packaged,
    url: e.url,
    assetBase: e.packaged ? `${prefix}${e.id}/assets/` : null,
    assets: e.assets.sort(),
    size: 0,
    modified_at: 1,
    metadataAvailable: false,
    metadata: null,
    status: null,
    thumbnail: null,
  }));
}

// Font files the page carries (anywhere in assets/ but a plugin's own folder), answered as the editor's custom fonts:
// each one is the family of its file name, so a text layer set to "Manrope" draws with assets/Manrope.ttf — offline,
// and the font loader asks Google Fonts only for families no file provides.
const FONT_FILE = /\.(ttf|otf|woff2?)$/i;
async function fontEntries(keys) {
  const files = keys.filter((k) => k.startsWith('asset:') && !k.startsWith('asset:plugins/') && FONT_FILE.test(k));
  const rows = await Promise.all(files.map(async (k) => ({
    id: k,
    family: decodeURIComponent(k.slice('asset:'.length).split('/').pop()).replace(FONT_FILE, ''),
    url: await activeResolver?.url?.(k),
  })));
  return rows.filter((f) => typeof f.url === 'string' && f.family);
}

// A package's own writes back to "the install": its proof and its metadata, kept for the CLI.
function recordPluginWrite(path, body) {
  const m = path.match(/^\/api\/(effects|advanced-transitions)\/local\/([^/]+)\/(status|metadata|thumbnail)$/);
  if (!m || m[3] === 'thumbnail') return Boolean(m);
  const kind = m[1] === 'effects' ? 'effects' : 'transitions';
  const id = decodeURIComponent(m[2]);
  const key = `${kind}:${id}`;
  let parsed = null;
  try { parsed = typeof body === 'string' ? JSON.parse(body) : null; } catch { /* not JSON */ }
  pluginReports.set(key, { kind, id, ...(pluginReports.get(key) || {}), [m[3]]: parsed });
  return true;
}

/** The plugins this page carries and what each one's proof said: [{ kind, id, ok, error, assets }]. */
export function pluginStatus() {
  const keys = activeResolver?.keys?.() || [];
  const out = [];
  for (const kind of Object.keys(PLUGIN_KINDS)) {
    for (const e of pluginEntries(keys, kind)) {
      const rep = pluginReports.get(`${kind}:${e.id}`) || {};
      const st = rep.status;
      out.push({
        kind,
        id: e.id,
        // effects publish a proof; a transition validates on load and publishes its metadata
        ok: kind === 'effects' ? (st ? st.ok === true : null) : (rep.metadata ? true : null),
        error: st && st.ok === false ? (st.error || 'failed') : null,
        assets: e.assets.length,
      });
    }
  }
  return out;
}

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const pathOf = (url) => url.split(/[?#]/)[0];

export function installFetchLayer() {
  if (!nativeFetch || window.__greenlightMotionFetch) return;
  window.__greenlightMotionFetch = true;
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    // the review server's own routes (`greenlight-motion review`, ./useReview.js) are real requests
    if (url.includes('/__glm/')) return nativeFetch(input, init);
    const ref = refFor(url);
    const path = ref ? pathOf(ref) : '';
    if (path.startsWith('/api/')) {
      const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      if (method === 'GET' || method === 'HEAD') {
        for (const kind of Object.keys(PLUGIN_KINDS)) {
          const k = PLUGIN_KINDS[kind];
          if (path === k.list) return json(200, { [k.key]: pluginEntries(activeResolver?.keys?.() || [], kind) });
        }
      } else if (recordPluginWrite(path, init && init.body)) {
        return json(200, { ok: true });
      }
      if ((method === 'GET' || method === 'HEAD') && path === '/api/fonts') return json(200, { fonts: await fontEntries(activeResolver?.keys?.() || []) });
      const list = method === 'GET' || method === 'HEAD' ? API_LISTS[path] : null;
      return list ? json(200, list) : json(404, { detail: 'Not available in the GreenLight Motion Engine' });
    }
    if (ref) {
      const blob = activeResolver ? await activeResolver.blob(path) : null;
      if (blob) return new Response(blob, { status: 200, headers: { 'content-type': blob.type || 'application/octet-stream' } });
      missingRefs.add(path);
      return json(404, { detail: `Asset not provided: ${path}` });
    }
    return nativeFetch(input, init);
  };
}

/** The resolver for ASSETS (map or function), with one fetch per ref. */
export function createResolver(assets) {
  const base = typeof assets === 'function'
    ? (ref) => assets(ref)
    : (ref) => (assets && Object.prototype.hasOwnProperty.call(assets, ref) ? assets[ref] : null);
  const lookup = base;
  const blobs = new Map();
  const urls = new Map();
  const objectUrls = new Set();
  const toBlob = async (value) => {
    if (value == null) return null;
    if (value instanceof Blob) return value;
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return new Blob([value]);
    if (typeof value === 'string') {
      const res = await nativeFetch(value);
      return res.ok ? res.blob() : null;
    }
    return null;
  };
  return {
    // the refs a map offers (plugins are found by name); a function resolver lists what its `keys` gives
    keys() {
      return typeof assets === 'function' ? (Array.isArray(assets.keys) ? assets.keys : []) : (assets ? Object.keys(assets) : []);
    },
    blob(ref) {
      if (!blobs.has(ref)) blobs.set(ref, Promise.resolve(lookup(ref)).then(toBlob).catch(() => null));
      return blobs.get(ref);
    },
    // A URL an <img>/<video> can use: the caller's own data:/blob:/https: string as is, else a blob: URL.
    url(ref) {
      if (!urls.has(ref)) {
        urls.set(ref, Promise.resolve(lookup(ref)).then(async (value) => {
          if (typeof value === 'string' && /^(data:|blob:|https:)/.test(value)) return value;
          const blob = await toBlob(value);
          if (!blob) return null;
          const u = URL.createObjectURL(blob);
          objectUrls.add(u);
          // a blob: URL has no extension; code that tells a video from a picture by its URL reads this hint
          const kind = /^video\/(mp4|webm|quicktime|ogg)/.exec(blob.type || '');
          return kind ? `${u}#media.${kind[1] === 'quicktime' ? 'mov' : kind[1]}` : u;
        }).catch(() => null));
      }
      return urls.get(ref);
    },
    dispose() {
      for (const u of objectUrls) URL.revokeObjectURL(u);
      objectUrls.clear();
    },
  };
}

export function setActiveResolver(resolver) {
  activeResolver = resolver;
}

/** A copy of PROJECT with every asset reference replaced by a URL the browser can texture. */
export async function resolveProject(project, resolver) {
  const unresolved = new Set();
  const walk = async (value) => {
    if (isProjectRef(value)) {
      const url = await resolver.url(value);
      if (url) return url;
      unresolved.add(value);
      return value;
    }
    if (Array.isArray(value)) return Promise.all(value.map(walk));
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = await walk(v);
      return out;
    }
    return value;
  };
  const resolved = await walk(project);
  for (const ref of unresolved) missingRefs.add(ref);
  return resolved;
}

/** Every asset reference asked for and not provided, so far. */
export function missingAssets() {
  return [...missingRefs];
}

export function clearMissingAssets() {
  missingRefs.clear();
}
