// Load announcements for the lazily-imported model3dLayer module.
//
// The compositor repaints on demand, so an async asset landing (model parse, HDR
// environment, screen artwork) must announce itself or the layer stays invisible
// until the next user-driven frame — a freshly loaded custom model only appeared
// once playback started. This hub lives in its own tiny module because Player
// subscribes statically while model3dLayer itself stays behind a dynamic import.
const listeners = new Set();

/** Subscribe to "some model-related asset finished loading". Returns unsubscribe. */
export function onModelAssetLoaded(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function notifyModelAssetLoaded() {
  for (const cb of listeners) {
    try { cb(); } catch { /* a listener's failure is not the loader's problem */ }
  }
}
