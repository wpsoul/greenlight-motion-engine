/*
 * The URL a package's own file loads from (a .gleffect's `textures`, a .gltransition's TRANSITION_ASSETS).
 * In the app the server serves them under the package's `assetBase`, so the URL is used as it is. A page with no
 * server (the GreenLight Motion engine bundle, opened from file://) installs a resolver that maps those URLs to its
 * own files (frontend/src/motionEngine/assets.js). Nothing is installed in the app.
 */
let resolver = null;

/** fn(url) → a URL the browser can load (or null to keep `url`); null uninstalls it. */
export function setPackageAssetResolver(fn) {
  resolver = typeof fn === 'function' ? fn : null;
}

export async function packageAssetUrl(url) {
  if (!resolver) return url;
  try {
    return (await resolver(url)) || url;
  } catch {
    return url;
  }
}
