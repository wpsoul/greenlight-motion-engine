/*
 * Shared loader for the transformers.js runtime used by the Depth and
 * AI Reframe workers.
 *
 * Nothing is bundled or shipped in the installer (the runtime + weights is
 * ~60 MB, and Windows Defender has flagged large bundled binaries before).
 * Instead of hitting the CDN straight from the renderer, everything —
 * runtime, ONNX WASM binaries, model weights — now routes through the local
 * backend's disk cache (/api/model-cache, backend/model_cache.py):
 *
 *  - external source first (jsdelivr / huggingface.co), GreenLight R2
 *    mirror as fallback when the CDN is unreachable;
 *  - cached under app data, so it survives app updates (the desktop shell
 *    clears the browser cache on every version change) and reinstalls;
 *  - revalidated upstream every ~90 days so new releases still arrive.
 *
 * A direct CDN import remains as a last-ditch fallback for harnesses that
 * run without the backend.
 */

const TRANSFORMERS_PKG = '@huggingface/transformers@3';
const CDN_LIB_URL = `https://cdn.jsdelivr.net/npm/${TRANSFORMERS_PKG}/dist/transformers.min.js`;
const PROXY_ROOT = '/api/model-cache';

let modPromise = null;

export function loadTransformers() {
  if (!modPromise) {
    modPromise = (async () => {
      // Workers resolve relative URLs against the worker script, so build
      // absolute URLs from the page origin explicitly.
      const proxyDist = `${self.location.origin}${PROXY_ROOT}/npm/${TRANSFORMERS_PKG}/dist/`;
      try {
        // @vite-ignore keeps Vite from trying to resolve/pre-bundle the URL.
        const mod = await import(/* @vite-ignore */ `${proxyDist}transformers.min.js`);
        // The webpack bundle loads ort.bundle.min.mjs relative to itself
        // (already proxied), but defaults wasmPaths back to jsdelivr and
        // model weights to huggingface.co — point both at the cache too.
        mod.env.remoteHost = `${self.location.origin}${PROXY_ROOT}/hf/`;
        mod.env.backends.onnx.wasm.wasmPaths = proxyDist;
        // The backend disk cache is the cache; the browser Cache API copy
        // would dodge the periodic upstream revalidation.
        mod.env.useBrowserCache = false;
        return mod;
      } catch {
        // No backend reachable (bare Vite harness) — original direct-CDN
        // flow with the browser cache.
        return import(/* @vite-ignore */ CDN_LIB_URL);
      }
    })();
    modPromise.catch(() => { modPromise = null; });
  }
  return modPromise;
}
