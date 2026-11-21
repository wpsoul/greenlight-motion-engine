// (motion3d) The engine's 3D plugin: where a page gets the 3D world from (the `greenlight-motion-3d` package), and when.
//
// The 2D engine carries the Scene layer's bridge (components/videoEditor/world3dLayer.js) but not the world itself (world3d.js, its
// node-graph, physics, sim and texture-graph bundles, the denoiser weights: ~19 MB). They come from the plugin:
//   - the page names a folder (GreenLightMotion.setWorldBase(url), create / mountPage { worldBase }, or window.GL_WORLD_BASE —
//     the CLI writes that into a project folder's assets.js, where it copied the plugin's dist/world3d/): the files load from there;
//   - else jsDelivr, at the newest release of the range this engine was built for (motion-engine/package.json peerDependencies),
//     read once from that range's manifest.json and then pinned to its exact version, so every file of one page is one release.
// Nothing is fetched until a Scene layer first needs the world (the layer's resolver, below), or until the page asks: `load()` — a
// "Download 3D plugin" button. A plugin whose manifest names another world API than this engine's is refused with a message saying
// which versions fit (world3dContract.js).
import { setWorldBase as setLayerBase, setWorldResolver } from '../components/videoEditor/world3dLayer';
import { WORLD3D_PACKAGE, WORLD3D_API, WORLD3D_CDN, cdnRange, hasWorld } from './world3dContract';

// the 3D releases this engine takes (its package.json peerDependencies, put in at build time); null when built some other way
const RANGE = typeof __GLM3D_RANGE__ === 'string' ? __GLM3D_RANGE__ : null;
const ENGINE = typeof __GLM_VERSION__ === 'string' ? __GLM_VERSION__ : 'dev';

let explicit = null;      // the folder the page named
let cdn = WORLD3D_CDN;
let pending = null;       // the one resolve in flight (or done)
const status = { state: 'idle', package: WORLD3D_PACKAGE, range: RANGE, api: WORLD3D_API, version: null, base: null, from: null, bytes: 0, error: null };
const listeners = new Set();
const publish = (patch) => {
  Object.assign(status, patch);
  const now = { ...status };
  for (const f of listeners) { try { f(now); } catch { /* a listener's own trouble */ } }
};
const slash = (u) => String(u).replace(/\/?$/, '/');
const absolute = (u) => { try { return new URL(u, typeof document !== 'undefined' ? document.baseURI : undefined).href; } catch { return String(u); } };

/** The folder the world's files are in (world3d.js, manifest.json …), or null for the default (jsDelivr at this engine's range). */
export function setBase(url) {
  explicit = url ? slash(absolute(url)) : null;
  setLayerBase(explicit);
  pending = null;
  publish({ state: 'idle', base: explicit, version: null, from: explicit ? 'page' : null, bytes: 0, error: null });
}
/** Another npm CDN in place of jsDelivr (same layout: <cdn>/<package>@<version>/<path>), for a mirror or a test stand-in. */
export function setCdn(url) {
  cdn = String(url || WORLD3D_CDN).replace(/\/+$/, '');
  if (!explicit) { pending = null; publish({ state: 'idle', base: null, version: null, error: null }); }
}

async function manifestAt(base, { optional = false } = {}) {
  let r;
  try { r = await fetch(`${base}manifest.json`, { cache: 'no-cache' }); } catch (e) {
    if (optional) return null;
    throw new Error(`the 3D plugin could not be reached at ${base} (${e?.message || e})`);
  }
  if (!r.ok) {
    if (optional && r.status === 404) return null;   // a copy made before manifests: it loads as it is
    throw new Error(`the 3D plugin answered ${r.status} at ${base}manifest.json`);
  }
  return r.json();
}

const sizeOf = (url) => {
  try {
    const e = performance.getEntriesByName(url).slice(-1)[0];
    return e ? (e.encodedBodySize || e.transferSize || 0) : 0;
  } catch { return 0; }
};

/** Where the world is and that it fits this engine; then its main module, loaded once (the layer's own import finds it in the module
 *  map). Resolves to the status; rejects with a message for people when the plugin cannot be had. */
export function resolve() {
  if (pending) return pending;
  pending = (async () => {
    publish({ state: 'loading', error: null });
    const named = explicit || (typeof window !== 'undefined' && window.GL_WORLD_BASE ? slash(absolute(window.GL_WORLD_BASE)) : null);
    let base = named, manifest = null, from = named ? 'page' : 'cdn';
    if (named) manifest = await manifestAt(named, { optional: true });
    else {
      if (!RANGE) throw new Error('this engine build names no 3D plugin release: set GreenLightMotion.setWorldBase(<folder with world3d.js>)');
      const ranged = `${cdn}/${WORLD3D_PACKAGE}@${cdnRange(RANGE)}/dist/world3d/`;
      manifest = await manifestAt(ranged);
      if (!manifest?.version) throw new Error(`the 3D plugin's manifest at ${ranged} names no version`);
      base = `${cdn}/${WORLD3D_PACKAGE}@${manifest.version}/dist/world3d/`;
    }
    if (manifest && manifest.api !== WORLD3D_API) {
      throw new Error(`the 3D plugin ${manifest.version || ''} speaks world API ${manifest.api}, this engine (${ENGINE}) speaks ${WORLD3D_API}: `
        + `use ${WORLD3D_PACKAGE}@${RANGE || '<the release built with this engine>'}`);
    }
    setLayerBase(base);
    publish({ base, version: manifest?.version || null, from });
    const main = `${base}world3d.js`;
    await import(/* @vite-ignore */ main);
    publish({ state: 'ready', bytes: sizeOf(main) || manifest?.files?.['world3d.js']?.bytes || 0 });
    return { ...status };
  })().catch((e) => {
    pending = null;   // the next Scene (or press) tries again
    publish({ state: 'failed', error: String(e?.message || e) });
    throw e;
  });
  return pending;
}

// the Scene layer asks before its first world loads; a 2D project never does
setWorldResolver(() => resolve());

/** GreenLightMotion.world3d: the 3D plugin, for a page's "Download 3D plugin" button and its status line. */
export const world3d = {
  /** { state: 'idle' | 'loading' | 'ready' | 'failed', package, range, api, version, base, from: 'page' | 'cdn', bytes, error } */
  status: () => ({ ...status }),
  /** Calls `fn(status)` on every change; returns the unsubscribe. */
  onStatus(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  /** Gets the plugin now (a Scene would get it by itself): resolves to the status. */
  load: () => resolve(),
  /** Whether a project needs the plugin (it has a 3D Scene). */
  needed: (project) => hasWorld(project),
  setBase,
  setCdn,
};
