// (motion3d) The contract between the GreenLight Motion Engine (`greenlight-motion`, 2D, Apache-2.0) and its 3D plugin
// (`greenlight-motion-3d`: the world's files — world3d.js and the bundles it loads, the denoiser weights — plus its own player and CLI).
//
// WORLD3D_API is the version of what the engine's Scene layer (components/videoEditor/world3dLayer.js) asks of the world's host
// (src/world3d/host.js createWorldHost: its options, the host's methods and the WorldRenderer calls the layer makes). Both packages
// are built from one tree: the 3D package writes it into dist/world3d/manifest.json (motion-engine-3d/scripts/prepare.mjs), the
// engine refuses a plugin whose manifest names another (world3dPlugin.js). Bump it when the layer and the host stop fitting
// together, and bump the engine's peer range (motion-engine/package.json peerDependencies) to the 3D release that has it.
// Pure data: Node reads it too.
export const WORLD3D_PACKAGE = 'greenlight-motion-3d';
export const WORLD3D_API = 1;
// Where browsers get the plugin when the page names no place of its own: jsDelivr serves every npm release with CORS.
export const WORLD3D_CDN = 'https://cdn.jsdelivr.net/npm';
// Where a page with no backend gets the bundled HDR presets a Scene names as /hdr/<name>.hdr (the GreenLight Motion connector's
// pass-through of the files CDN, which sends no CORS headers itself).
export const WORLD3D_HDR = 'https://mcp.greenlightdash.pro/motion/3d/hdr/';

/** A semver range as jsDelivr takes it in a URL: "~0.1.0" → "0.1", "^1.2.0" → "1", "^0.3.1" → "0.3", "1.4.2" → "1.4.2". */
export function cdnRange(range) {
  const m = /^\s*([~^]?)(\d+)\.(\d+)\.(\d+)\s*$/.exec(String(range || ''));
  if (!m) return String(range || 'latest');
  const [, op, major, minor] = m;
  if (op === '~' || (op === '^' && major === '0')) return `${major}.${minor}`;
  if (op === '^') return major;
  return `${major}.${minor}.${m[4]}`;
}

/** Whether `version` ("0.1.3") is inside `range` ("~0.1.0", "^0.1.0", "^1.2.0", "0.1.3", ">=0.5.0 <0.6.0"). Prereleases never match a range. */
export function satisfies(version, range) {
  const v = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version || '').trim());
  if (!v) return false;
  const n = v.slice(1).map(Number);
  const cmp = (a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]);
  return String(range || '').trim().split(/\s+/).every((part) => {
    const m = /^(>=|<=|>|<|=|~|\^)?(\d+)\.(\d+)\.(\d+)$/.exec(part);
    if (!m) return false;
    const r = m.slice(2).map(Number);
    switch (m[1]) {
      case '>=': return cmp(n, r) >= 0;
      case '<=': return cmp(n, r) <= 0;
      case '>': return cmp(n, r) > 0;
      case '<': return cmp(n, r) < 0;
      case '~': return cmp(n, r) >= 0 && n[0] === r[0] && n[1] === r[1];
      case '^': return cmp(n, r) >= 0 && (r[0] > 0 ? n[0] === r[0] : r[1] > 0 ? n[0] === 0 && n[1] === r[1] : n[0] === 0 && n[1] === 0 && n[2] === r[2]);
      default: return cmp(n, r) === 0;
    }
  });
}

/** Whether a project has a 3D Scene (a Scene layer whose Rig renders with the world), in its timeline or inside a sequence. */
export function hasWorld(project) {
  const walk = (channels, clips) => (channels || []).some((ch) => (ch?.items || []).some((it) => it?.rig?.renderer === 'world'))
    || (clips || []).some((c) => c?.sequence && walk(c.sequence.channels, c.sequence.clips));
  return !!project && walk(project.channels, project.clips);
}
