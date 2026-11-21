// The 3D plugin (`greenlight-motion-3d`) for the CLI: found where it already is, or downloaded once into this computer's cache —
// the way Playwright keeps its browsers. A project folder with a 3D Scene gets the plugin's dist/world3d/ copied beside its page.
//
// Where it is looked for, in order:
//   1. GREENLIGHT_MOTION_3D: a folder (an unpacked package, or its dist/world3d/) or a .tgz of it — offline installs, tests
//   2. an installed package (`npm i greenlight-motion-3d` next to the project, or beside this one) whose version fits the range
//   3. the cache: <cache>/greenlight-motion-3d/<version>/ (GREENLIGHT_MOTION_3D_CACHE, else the OS's cache folder)
//   4. the npm registry (GREENLIGHT_MOTION_3D_REGISTRY, else npm_config_registry, else registry.npmjs.org): the newest release in
//      the range, its tarball checked against the registry's sha512 before it is unpacked
// Synchronous (curl, like the CLI's sound and 3D file downloads), so `build` stays one plain step.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { gunzipSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';

export const NAME = 'greenlight-motion-3d';
// the world API this engine's Scene layer speaks: frontend/src/motionEngine/world3dContract.js WORLD3D_API, which the CLI passes in from
// its scene script bundle (dist/greenlight-motion-script.mjs); this is only the fallback
export const API = 1;

/** Whether `version` is inside `range` (~x.y.z, ^x.y.z, x.y.z, or >= / < bounds separated by spaces). */
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
const newest = (list) => list.slice().sort((a, b) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  return (y[0] - x[0]) || (y[1] - x[1]) || (y[2] - x[2]);
})[0];

/** The cache folder the plugin's releases are kept in. */
export function cacheRoot() {
  if (process.env.GREENLIGHT_MOTION_3D_CACHE) return path.resolve(process.env.GREENLIGHT_MOTION_3D_CACHE);
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Caches', 'greenlight-motion', NAME);
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'greenlight-motion', 'Cache', NAME);
  return path.join(process.env.XDG_CACHE_HOME || path.join(home, '.cache'), 'greenlight-motion', NAME);
}

/** A plugin folder's facts: { dir, world, version, api, manifest } or null when it is not one. `dir` may be the package or its dist/world3d. */
export function inspect(dir) {
  const candidates = [path.join(dir, 'dist', 'world3d'), dir];
  for (const world of candidates) {
    const manifestFile = path.join(world, 'manifest.json');
    if (!existsSync(path.join(world, 'world3d.js')) || !existsSync(manifestFile)) continue;
    let manifest;
    try { manifest = JSON.parse(readFileSync(manifestFile, 'utf8')); } catch { continue; }
    return { dir: world === dir ? path.dirname(path.dirname(dir)) : dir, world, version: manifest.version, api: manifest.api, manifest };
  }
  return null;
}

/** Every file of the manifest there, with its size and sha256: the names of what is missing or changed ([] when the copy is whole). */
export function verify(found) {
  const bad = [];
  for (const [name, f] of Object.entries(found.manifest.files || {})) {
    const p = path.join(found.world, name);
    if (!existsSync(p)) { bad.push(`${name} (missing)`); continue; }
    if (statSync(p).size !== f.bytes) { bad.push(`${name} (size)`); continue; }
    if (f.sha256 && createHash('sha256').update(readFileSync(p)).digest('hex') !== f.sha256) bad.push(`${name} (content)`);
  }
  return bad;
}

// ── a .tgz → files (npm's tarballs: gzip'd ustar, every path under package/, pax headers for long names) ──
function untar(gz, into) {
  const tar = gunzipSync(gz);
  const str = (b, at, len) => { const s = b.subarray(at, at + len); const z = s.indexOf(0); return s.subarray(0, z < 0 ? len : z).toString('utf8'); };
  let at = 0, longName = null, count = 0;
  while (at + 512 <= tar.length) {
    const head = tar.subarray(at, at + 512);
    if (head.every((b) => b === 0)) break;
    const size = parseInt(str(head, 124, 12).trim() || '0', 8) || 0;
    const type = String.fromCharCode(head[156] || 48);
    let name = longName || (str(head, 345, 155) ? `${str(head, 345, 155)}/${str(head, 0, 100)}` : str(head, 0, 100));
    longName = null;
    const body = tar.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') {   // pax: this entry's path for the next one
      const m = /\d+ path=([^\n]*)\n/.exec(body.toString('utf8'));
      if (m) longName = m[1];
      continue;
    }
    if (type === 'g' || type === '5') continue;
    if (type !== '0' && type !== '\0' && type !== '7') continue;   // links and devices: never in a package of ours
    name = name.replace(/^package\//, '');
    if (!name || path.isAbsolute(name) || name.split(/[\\/]/).some((s) => s === '..')) throw new Error(`the 3D plugin's tarball has a path outside its folder: ${name}`);
    const dest = path.join(into, name);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, body);
    count += 1;
  }
  return count;
}

const curl = (url, out = null) => {
  const args = ['-sfL', '--max-time', '600', ...(out ? ['-o', out] : []), url];
  const r = spawnSync('curl', args, { maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`could not download ${url} (curl exit ${r.status}${r.error ? `: ${r.error.message}` : ''})`);
  return out ? null : r.stdout;
};

/** A .tgz unpacked into the cache under its own version; returns its folder (a version already there is kept as it is). */
function cacheTarball(bytes, { integrity = null, from = 'a tarball' } = {}) {
  if (integrity) {
    const [algo, want] = String(integrity).split('-');
    const got = createHash(algo || 'sha512').update(bytes).digest('base64');
    if (got !== want) throw new Error(`the 3D plugin downloaded from ${from} does not match the registry's ${algo} — not unpacked`);
  }
  const root = cacheRoot();
  mkdirSync(root, { recursive: true });
  const tmp = path.join(root, `.unpack-${process.pid}-${Date.now()}`);
  try {
    untar(bytes, tmp);
    const found = inspect(tmp);
    if (!found) throw new Error(`${from} is not the 3D plugin (no dist/world3d/manifest.json)`);
    const meta = JSON.parse(readFileSync(path.join(tmp, 'package.json'), 'utf8'));
    if (meta.name !== NAME) throw new Error(`${from} is ${meta.name}, not ${NAME}`);
    const bad = verify(found);
    if (bad.length) throw new Error(`${from} is not whole: ${bad.slice(0, 4).join(', ')}`);
    const dest = path.join(root, meta.version);
    if (existsSync(path.join(dest, '.complete'))) { rmSync(tmp, { recursive: true, force: true }); return dest; }
    rmSync(dest, { recursive: true, force: true });
    renameSync(tmp, dest);
    writeFileSync(path.join(dest, '.complete'), `${new Date().toISOString()} ${from}\n`);
    return dest;
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

/** The cached releases, newest first: [{ version, dir }]. */
export function cached() {
  const root = cacheRoot();
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((v) => /^\d+\.\d+\.\d+$/.test(v) && existsSync(path.join(root, v, '.complete')))
    .sort((a, b) => (newest([a, b]) === a ? -1 : 1)).map((version) => ({ version, dir: path.join(root, version) }));
}

/**
 * The plugin for an engine that takes `range`: { dir, world, version, from: 'env' | 'installed' | 'cache' | 'download' }.
 * `download: false` only looks (doctor). Throws a message for people when it cannot be had.
 */
export function find3d({ range, api = API, download = true, from = [process.cwd()], log = null } = {}) {
  const fits = (found) => found && found.api === api && (!range || satisfies(found.version, range));
  const why = (found) => (found.api !== api ? `speaks world API ${found.api}, this engine ${api}` : `${found.version} is not in ${range}`);
  const env = process.env.GREENLIGHT_MOTION_3D;
  if (env) {
    const p = path.resolve(env);
    if (!existsSync(p)) throw new Error(`GREENLIGHT_MOTION_3D=${env}: no such file or folder`);
    let found = statSync(p).isDirectory() ? inspect(p) : inspect(cacheTarball(readFileSync(p), { from: p }));
    if (!found) throw new Error(`GREENLIGHT_MOTION_3D=${env} is not the 3D plugin (no dist/world3d/manifest.json)`);
    if (!fits(found)) throw new Error(`GREENLIGHT_MOTION_3D=${env}: ${why(found)}`);
    return { ...found, from: 'env' };
  }
  for (const base of from) {
    try {
      const req = createRequire(path.join(path.resolve(base), 'noop.js'));
      const found = inspect(path.dirname(req.resolve(`${NAME}/package.json`)));
      if (fits(found)) return { ...found, from: 'installed' };
    } catch { /* not installed there */ }
  }
  for (const c of cached()) {
    const found = inspect(c.dir);
    if (fits(found)) return { ...found, from: 'cache' };
  }
  if (!download) return null;
  const registry = String(process.env.GREENLIGHT_MOTION_3D_REGISTRY || process.env.npm_config_registry || 'https://registry.npmjs.org/').replace(/\/?$/, '/');
  log?.(`downloading the 3D plugin (${NAME}${range ? `@${range}` : ''}) from ${registry} — once, into ${cacheRoot()}`);
  let doc;
  try { doc = JSON.parse(curl(`${registry}${NAME}`).toString('utf8')); } catch (e) { throw new Error(`the 3D plugin could not be looked up: ${e.message}. Online once (or set GREENLIGHT_MOTION_3D to a copy), then try again`); }
  const versions = Object.keys(doc.versions || {}).filter((v) => /^\d+\.\d+\.\d+$/.test(v) && (!range || satisfies(v, range)));
  if (!versions.length) throw new Error(`no release of ${NAME} fits this engine (${range}); the registry has ${Object.keys(doc.versions || {}).join(', ') || 'none'}`);
  const version = newest(versions);
  const meta = doc.versions[version];
  const tmp = path.join(os.tmpdir(), `${NAME}-${version}-${process.pid}.tgz`);
  try {
    curl(meta.dist.tarball, tmp);
    const dir = cacheTarball(readFileSync(tmp), { integrity: meta.dist.integrity || null, from: meta.dist.tarball });
    const found = inspect(dir);
    if (!fits(found)) throw new Error(`${NAME}@${version}: ${why(found)}`);
    log?.(`3D plugin ${version} ready (${dir})`);
    return { ...found, from: 'download' };
  } finally { rmSync(tmp, { force: true }); }
}
