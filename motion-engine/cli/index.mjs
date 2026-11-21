#!/usr/bin/env node
// greenlight-motion — the GreenLight Motion Engine's command line, for AI agents (skill/SKILL.md).
//
//   npx greenlight-motion doctor                     what this computer has, and how to fix what's missing
//   npx greenlight-motion init <dir> [--from p.json] a project folder: index.html, project.json, assets/
//   npx greenlight-motion script <dir> [--from s.json] [--force]   <dir>/script.json (a scene script) → project.json
//   npx greenlight-motion build <dir>                project.json + assets/ → a page the user double-clicks
//   npx greenlight-motion check <dir> [--json]       problems to fix (missing files, template, errors, blank frames)
//   npx greenlight-motion stills <dir> [--at 0.5,2] [--count 6] [--out d]   PNG frames + a labelled contact sheet
//   npx greenlight-motion render <dir> [--fps 60] [--motion-blur] [--volume 80] [--no-sfx] [--out f.mp4]
//   npx greenlight-motion pack <dir> [--out f.html]  everything in ONE html file (share it, or put it in a Claude artifact)
//   npx greenlight-motion pack <dir> --glvideo [--out f.glvideo]   ONE .glvideo file: double-clicked, it opens in GreenLight Dash
//   npx greenlight-motion set <dir> key=value …      template values (what the page's options panel changes)
//   npx greenlight-motion apply <dir> <edits.json|-> [--dry-run] [--json]   an atomic, validated batch of edits (cli/apply.mjs)
//   npx greenlight-motion trace <dir> [--fps 30] [--items a,b] [--out f.json]   every keyframed layer's values per frame + its moments
//   npx greenlight-motion events <dir> [--fps 30] [--out f.json] [--json]   when things move, stop, appear, cut and type on: where sounds go
//   npx greenlight-motion review <dir> [--live] [--port 4810] [--open]   the page for the user's review (Edit · Notes · Highlight):
//                                                    Save for agent writes <dir>/review/ (NOTES.md, notes.json, the pictures)
//   npx greenlight-motion review <dir> <dir2> … [--titles "A,B,C"] [--subs "…,…"] [--title t] [--out d] [--live] [--port 4810] [--open]
//                                                    ONE page for several films (the board's review card: Notes, Highlight across
//                                                    them, a pick); Save writes <first dir or --out>/review/ (cli/compare.mjs)
//   npx greenlight-motion pick <dir> [--title t] [--port 4811] [--open]   a pick page for generated pictures: <dir>/<frame>/*.png|jpg|webp
//                                                    (or <dir>/pick.json); Save writes <dir>/PICKS.json + PICKS.md (cli/pick.mjs)
//   npx greenlight-motion schema [topic]             the project format (format | template | effects | transitions | easings | paths | expressions | sounds)
//   npx greenlight-motion add-3d [--json]            the 3D plugin (greenlight-motion-3d) into this computer's cache now (doctor says what is there)
//   npx greenlight-motion pod-serve [--port 8080]    a render part on a GPU machine you own, driven from your page (GL_POD_TOKEN; cli/podServe.mjs)
//   A 3D Scene (a script's `world`) gets the 3D plugin by itself the first time (downloaded once); its folder plays from a local server
//   (review), and check / stills / render serve it themselves.
//
// Needs Node 18+ and Chrome or Edge (the engine draws with WebGPU; a headless *shell* has no WebGPU, so the CLI
// drives the real browser in its new headless mode). No ffmpeg: the page encodes the MP4 itself.
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, copyFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { applyEdits } from './apply.mjs';
import { glvideoBytes } from './glvideo.mjs';
import { find3d, cacheRoot, cached, NAME as NAME3D } from './plugin3d.mjs';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const ENGINE = path.join(PKG, 'dist', 'greenlight-motion.js');
// A 3D Scene (a Scene layer: rig.renderer "world", a script's `world`): its 3D engine is the 3D plugin, a package of its own
// (greenlight-motion-3d, at the release range this engine takes: package.json peerDependencies). The CLI finds it, or downloads it
// once into this computer's cache (cli/plugin3d.mjs), and copies its dist/world3d/ into the project folder as world3d/; assets.js
// tells the page to load it from there. Its files load as modules, which a file:// page cannot, so a page with a Scene is opened
// from a server on this computer (127.0.0.1) — review, and stills / render / check headless.
const hasWorld = (project) => {
  const walk = (channels, clips) => (channels || []).some((ch) => (ch?.items || []).some((it) => it?.rig?.renderer === 'world'))
    || (clips || []).some((c) => c?.sequence && walk(c.sequence.channels, c.sequence.clips));
  return !!project && walk(project.channels, project.clips);
};
const META = JSON.parse(readFileSync(path.join(PKG, 'package.json'), 'utf8'));
const VERSION = META.version;
// the plugin's releases this engine takes, and the world API its Scene layer speaks (schema/capabilities.json world3d, written by
// scripts/prepare.mjs from frontend/src/motionEngine/world3dContract.js)
const RANGE3D = META.peerDependencies?.[NAME3D] || null;
const API3D = () => SCHEMA().world3d?.api ?? 1;
let plugin = null;
function plugin3d({ quiet = false } = {}) {
  if (plugin) return plugin;
  try {
    plugin = find3d({ range: RANGE3D, api: API3D(), from: [process.cwd(), PKG], log: quiet ? null : (m) => console.log(m) });
  } catch (e) {
    fail(`this video has a 3D Scene, and the 3D plugin (${NAME3D}${RANGE3D ? `@${RANGE3D}` : ''}) is not here: ${e.message}`,
      'run npx greenlight-motion add-3d while online, or set GREENLIGHT_MOTION_3D to an unpacked copy or its .tgz');
  }
  return plugin;
}

// ── arguments ──
const argv = process.argv.slice(2);
const cmd = argv[0];
const flags = {};
const rest = [];
for (let i = 1; i < argv.length; i += 1) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split('=');
    if (v !== undefined) flags[k] = v;
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[k] = argv[++i];
    else flags[k] = true;
  } else rest.push(a);
}
const fail = (msg, hint) => {
  console.error(`greenlight-motion: ${msg}${hint ? `\n  → ${hint}` : ''}`);
  process.exit(1);
};

// ── the browser ──
const CHROMES = {
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium'],
  win32: [`${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`, `${process.env['PROGRAMFILES(X86)']}\\Google\\Chrome\\Application\\chrome.exe`, `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`, `${process.env['PROGRAMFILES(X86)']}\\Microsoft\\Edge\\Application\\msedge.exe`],
  linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'],
};
function findChrome() {
  if (process.env.GREENLIGHT_MOTION_CHROME && existsSync(process.env.GREENLIGHT_MOTION_CHROME)) return process.env.GREENLIGHT_MOTION_CHROME;
  return (CHROMES[process.platform] || []).find((p) => p && existsSync(p)) || null;
}
async function launch() {
  const chrome = findChrome();
  if (!chrome) fail('no Chrome or Edge found', 'install Google Chrome, or set GREENLIGHT_MOTION_CHROME to its executable');
  const { chromium } = require('playwright-core');
  return chromium.launch({ executablePath: chrome, headless: true, args: ['--headless=new', '--enable-unsafe-webgpu'] });
}

// ── a project folder ──
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.avif': 'image/avif',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.aac': 'audio/aac',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.hdr': 'application/octet-stream', '.exr': 'application/octet-stream', '.json': 'application/json',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2' };
const REF = /^(\/media\/|\/hdr\/|asset:|motion-engine-unbundled:)/;

function readProject(dir) {
  const file = path.join(dir, 'project.json');
  if (!existsSync(file)) fail(`no project.json in ${dir}`, `run: npx greenlight-motion init ${dir}`);
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch (e) { return fail(`project.json is not valid JSON: ${e.message}`); }
}
function filesUnder(root, base = root, out = []) {
  if (!existsSync(root)) return out;
  for (const name of readdirSync(root)) {
    const p = path.join(root, name);
    if (statSync(p).isDirectory()) filesUnder(p, base, out);
    else out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
}
// Every file under assets/ under the names a project or the engine may use for it.
function assetKeys(rel) {
  const keys = [`asset:${rel}`];
  if (rel.startsWith('media/')) keys.push(`/${rel}`);
  if (rel.startsWith('hdr/')) keys.push(`/${rel}`);
  if (rel.startsWith('models/')) keys.push(`motion-engine-unbundled:${rel.slice('models/'.length)}`);
  return keys;
}
const refsIn = (v, out = new Set()) => {
  if (typeof v === 'string') { if (REF.test(v)) out.add(v); }
  else if (Array.isArray(v)) v.forEach((x) => refsIn(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => refsIn(x, out));
  return out;
};
const indexHtml = (title) => `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${String(title || 'GreenLight Motion').replace(/[<&]/g, '')}</title>
<!-- Made with the GreenLight Motion Engine. Open this file in Chrome or Edge. Rebuild after editing project.json:
     npx greenlight-motion build . -->
<style>html, body { margin: 0; background: #0f1112; }</style>
<div id="app"></div>
<script src="greenlight-motion.js"></script>
<script src="project.js"></script>
<script src="assets.js"></script>
<script>GreenLightMotion.mountStudio(document.getElementById('app'), { project: window.GL_PROJECT, assets: window.GL_ASSETS });</script>
`;
// JSON inside a <script>: no "</script", no "<!--" (both escapes stay valid JSON and JS, so the app can read a page back)
const scriptSafe = (s) => s.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\u0021--');

// world: the folder holds the 3D plugin's files (world3d/): the page loads its 3D Scene's engine from there, not from the CDN
const assetsJs = (assets, aliases, world = false) => `window.GL_ASSETS = ${scriptSafe(JSON.stringify(assets))};
window.GL_ASSET_ALIASES = ${scriptSafe(JSON.stringify(aliases))};
(function (a, m) { for (var k in m) if (!(k in a)) a[k] = a[m[k]]; })(window.GL_ASSETS, window.GL_ASSET_ALIASES);
${world ? 'window.GL_WORLD_BASE = "world3d/";\n' : ''}`;

// The sounds a project's cues play: the library's files are on the sound CDN (schema/capabilities.json sounds.cdn;
// GREENLIGHT_SOUND_CDN overrides it). A cue's file is downloaded into assets/sounds/ once. Returns the refs still missing.
const SCHEMA = () => {
  try { return JSON.parse(readFileSync(path.join(PKG, 'schema', 'capabilities.json'), 'utf8')); } catch { return {}; }
};
const SOUND_SCHEMA = () => SCHEMA().sounds || {};
const SOUND_LIBRARY = () => SOUND_SCHEMA().library || {};
function ensureSoundFiles(dir, project) {
  const lib = SOUND_LIBRARY();
  const cdn = (process.env.GREENLIGHT_SOUND_CDN || SOUND_SCHEMA().cdn || '').replace(/\/+$/, '');
  const missing = [];
  for (const cue of Array.isArray(project.sounds) ? project.sounds : []) {
    const s = lib[cue?.sfx];
    if (!s) continue;   // check reports an unknown sound
    const dest = path.join(dir, 'assets', 'sounds', s.file);
    if (existsSync(dest)) continue;
    mkdirSync(path.dirname(dest), { recursive: true });
    const r = spawnSync('curl', ['-sfL', '--max-time', '60', '-o', dest, `${cdn}/${encodeURIComponent(s.file)}`]);
    if (r.status !== 0 || !existsSync(dest)) { rmSync(dest, { force: true }); missing.push(`asset:sounds/${s.file}`); }
  }
  // assets/sounds/ is build's own folder: a sound no cue uses any more (a cue removed, or a sound that left the
  // library) goes, unless the project refers to the file itself
  const folder = path.join(dir, 'assets', 'sounds');
  if (existsSync(folder)) {
    const used = new Set((Array.isArray(project.sounds) ? project.sounds : []).map((c) => lib[c?.sfx]?.file).filter(Boolean));
    const named = refsIn(project);
    for (const f of readdirSync(folder)) {
      if (!used.has(f) && !named.has(`asset:sounds/${f}`)) rmSync(path.join(folder, f), { force: true });
    }
  }
  return [...new Set(missing)];
}

// The 3D files a project uses: device presets (`model-preset:<id>` → assets/models/<file>.glb, which the engine asks
// for as motion-engine-unbundled:<file>) and lighting environments (`/hdr/<name>.hdr` or a bare name such as
// "potsdamer_platz_1k" → assets/hdr/<name>.hdr; a model layer lights itself with the default one). They are on the
// CDN (schema files3d; GREENLIGHT_FILES_CDN overrides the host) and downloaded once. Returns the refs still missing.
const stringsIn = (v, out = new Set()) => {
  if (typeof v === 'string') out.add(v);
  else if (Array.isArray(v)) v.forEach((x) => stringsIn(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => stringsIn(x, out));
  return out;
};
function ensure3dFiles(dir, project) {
  const f = SCHEMA().files3d;
  if (!f) return [];
  const host = (url) => (process.env.GREENLIGHT_FILES_CDN ? url.replace(/^https:\/\/[^/]+/, process.env.GREENLIGHT_FILES_CDN.replace(/\/+$/, '')) : url);
  const want = new Map();   // assets/<rel> → [url, the ref the engine asks for]
  const hdrs = new Set(f.hdrs || []);
  const addHdr = (name) => { if (hdrs.has(name)) want.set(`hdr/${name}`, [`${host(f.hdr)}/${name}`, `/hdr/${name}`]); };
  for (const s of stringsIn(project)) {
    const preset = /^model-preset:([\w-]+)$/.exec(s)?.[1];
    const file = preset && (f.presets?.[preset] || f.presets?.[f.retired?.[preset]]);
    if (file) want.set(`models/${file}`, [`${host(f.models)}/${file}`, `motion-engine-unbundled:${file}`]);
    const hdr = /^\/hdr\/([\w.-]+\.hdr)$/.exec(s)?.[1];
    if (hdr) addHdr(hdr);
    else if (hdrs.has(`${s}.hdr`)) addHdr(`${s}.hdr`);
  }
  if ((project.clips || []).some((c) => c?.mediaType === 'model3d') && f.defaultHdr) addHdr(f.defaultHdr);
  // a 3D Scene without an environment of its own is lit by the Scene's default one (rig3d.js ENV_DEFAULTS)
  if (hasWorld(project)) addHdr('studio_small_03_1k.hdr');
  const missing = [];
  for (const [rel, [url, ref]] of want) {
    const dest = path.join(dir, 'assets', rel);
    if (existsSync(dest)) continue;
    mkdirSync(path.dirname(dest), { recursive: true });
    const r = spawnSync('curl', ['-sfL', '--max-time', '300', '-o', dest, url]);
    if (r.status !== 0 || !existsSync(dest)) { rmSync(dest, { force: true }); missing.push(ref); }
  }
  return missing;
}

function build(dir, { quiet = false, sounds = true } = {}) {
  if (!existsSync(ENGINE)) fail('the engine bundle is missing from this package', 'reinstall greenlight-motion');
  const project = readProject(dir);
  // (chatfarm2) a picture-only part (pod-serve) needs no sound files
  const soundsMissing = [...(sounds ? ensureSoundFiles(dir, project) : []), ...ensure3dFiles(dir, project)];
  const assets = {};
  const aliases = {};   // other names of the same file: stored once, pointed at
  let bytes = 0;
  for (const rel of filesUnder(path.join(dir, 'assets'))) {
    const buf = readFileSync(path.join(dir, 'assets', rel));
    bytes += buf.length;
    const [first, ...others] = assetKeys(rel);
    assets[first] = `data:${MIME[path.extname(rel).toLowerCase()] || 'application/octet-stream'};base64,${buf.toString('base64')}`;
    for (const k of others) aliases[k] = first;
  }
  const missing = [...[...refsIn(project)].filter((r) => !assets[r] && !aliases[r]), ...soundsMissing];
  writeFileSync(path.join(dir, 'project.js'), `window.GL_PROJECT = ${scriptSafe(JSON.stringify(project))};\n`);
  const world = hasWorld(project);
  writeFileSync(path.join(dir, 'assets.js'), assetsJs(assets, aliases, world));
  copyFileSync(ENGINE, path.join(dir, 'greenlight-motion.js'));
  if (world) {
    // the 3D plugin's files beside the page (copied again only when its release changed)
    const p = plugin3d({ quiet });
    const to = path.join(dir, 'world3d');
    let had = null;
    try { had = JSON.parse(readFileSync(path.join(to, 'manifest.json'), 'utf8')).version; } catch { /* none yet */ }
    if (had !== p.version || readdirSync(p.world).some((f) => !existsSync(path.join(to, f)))) {
      rmSync(to, { recursive: true, force: true });
      mkdirSync(to, { recursive: true });
      for (const f of readdirSync(p.world)) copyFileSync(path.join(p.world, f), path.join(to, f));
    }
  }
  if (!existsSync(path.join(dir, 'index.html'))) writeFileSync(path.join(dir, 'index.html'), indexHtml(project.template?.title || project.name));
  if (!quiet) {
    console.log(`built ${path.join(dir, 'index.html')} — ${filesUnder(path.join(dir, 'assets')).length} file(s), ${(bytes / 1048576).toFixed(1)} MB of assets`);
    if (world) console.log(`it has a 3D Scene (the 3D plugin ${plugin?.version} in ${path.join(dir, 'world3d')}): it plays from a local server, not by double-click — npx greenlight-motion review ${dir}`);
    if (missing.length) console.log(`missing (put them in assets/): ${missing.join(', ')}`);
  }
  return { project, assets, aliases, missing, bytes };
}

// A project folder served read-only on 127.0.0.1 (a free port), for a page whose 3D Scene loads its engine as modules.
async function serveFolder(dir) {
  const http = await import('node:http');
  const root = path.resolve(dir);
  const types = { ...MIME, '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8' };
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = path.resolve(root, p === '/' ? 'index.html' : p.replace(/^\/+/, ''));
    if (!file.startsWith(root + path.sep) || !existsSync(file) || statSync(file).isDirectory() || (req.method !== 'GET' && req.method !== 'HEAD')) {
      res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return;
    }
    res.writeHead(200, { 'content-type': types[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : readFileSync(file));
  });
  await new Promise((ok, no) => { server.once('error', no); server.listen(0, '127.0.0.1', ok); });
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => server.close() };
}

// The page, headless: built, opened from file:// (a 3D Scene's from a local server), settled (files are asked for in waves — a
// model, then its HDR).
async function withPage(dir, fn) {
  const { project } = build(dir, { quiet: true });
  const served = hasWorld(project) ? await serveFolder(dir) : null;
  const browser = await launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e.message || e)));
    await page.goto(served ? served.url : 'file://' + path.resolve(dir, 'index.html'));
    await page.waitForFunction(() => window.GreenLightMotion?.page?.ready, null, { timeout: 90000 });
    const duration = await page.evaluate(() => window.GreenLightMotion.page.duration);
    for (const t of [0, duration / 2, Math.max(0, duration - 0.05)]) await page.evaluate((x) => window.GreenLightMotion.page.renderFrame(x), t);
    await page.waitForTimeout(600);
    return await fn({ page, errors, duration });
  } finally {
    await browser.close();
    served?.close();
  }
}
const parseTimes = (duration) => {
  if (flags.at) return String(flags.at).split(',').map(Number).filter((t) => Number.isFinite(t) && t >= 0);
  const n = Math.max(1, Math.min(48, Number(flags.count) || 6));
  return Array.from({ length: n }, (_, i) => +((duration * (i + 0.5)) / n).toFixed(3));
};

// ── commands ──
async function doctor() {
  const checks = [];
  const add = (name, ok, detail, fix) => checks.push({ name, ok, detail, fix: ok ? undefined : fix });
  const major = Number(process.versions.node.split('.')[0]);
  add('Node.js 18 or newer', major >= 18, process.versions.node, 'install Node.js 18+ from nodejs.org');
  const chrome = findChrome();
  add('Chrome or Edge', !!chrome, chrome || 'not found', 'install Google Chrome, or set GREENLIGHT_MOTION_CHROME to its executable');
  add('engine bundle', existsSync(ENGINE), existsSync(ENGINE) ? path.relative(process.cwd(), ENGINE) : 'missing', 'reinstall greenlight-motion');
  // the 3D plugin: not a fault when it is not here yet (a video with a 3D Scene downloads it), only when what is here does not fit
  let found3d = null, why3d = null;
  try { found3d = find3d({ range: RANGE3D, api: API3D(), from: [process.cwd(), PKG], download: false }); } catch (e) { why3d = e.message; }
  const others = cached().filter((c) => c.version !== found3d?.version).map((c) => c.version);
  add(`3D plugin (${NAME3D}${RANGE3D ? ` ${RANGE3D}` : ''})`, !why3d,
    found3d ? `${found3d.version} (${found3d.from === 'cache' ? 'cache' : found3d.from}: ${found3d.world})` : why3d || `not downloaded yet: a video with a 3D Scene gets it (once, ~19 MB into ${cacheRoot()}), or now: npx greenlight-motion add-3d${others.length ? `; other releases cached: ${others.join(', ')}` : ''}`,
    'unset GREENLIGHT_MOTION_3D or point it at a release that fits, then npx greenlight-motion add-3d');
  if (chrome) {
    try {
      const browser = await launch();
      const page = await browser.newPage();
      // WebGPU and WebCodecs exist only in a secure context: a file:// page is one, about:blank is not.
      await page.goto(pathToFileURL(path.join(PKG, 'package.json')).href);
      const gpu = await page.evaluate(async () => {
        const a = await navigator.gpu?.requestAdapter();
        const h264 = typeof VideoEncoder === 'function' && (await VideoEncoder.isConfigSupported({ codec: 'avc1.640028', width: 1920, height: 1080, bitrate: 8e6, framerate: 30 })).supported;
        return { webgpu: !!a, adapter: a?.info ? [a.info.vendor, a.info.architecture].filter(Boolean).join(' ') : '', h264,
          storage: a?.limits?.maxStorageBuffersPerShaderStage || 0, maxBuffer: a?.limits?.maxBufferSize || 0 };
      });
      await browser.close();
      add('WebGPU (headless)', gpu.webgpu, gpu.adapter || (gpu.webgpu ? 'adapter' : 'no adapter'), 'update Chrome; on Linux servers WebGPU needs Vulkan or SwiftShader');
      add('H.264 encoding (WebCodecs)', gpu.h264, gpu.h264 ? 'supported' : 'not supported', 'use Google Chrome (open-source Chromium on Linux lacks H.264)');
      if (gpu.webgpu) add('WebGPU limits for a 3D Scene', gpu.storage >= 8, `${gpu.storage} storage buffers per stage, largest buffer ${Math.round(gpu.maxBuffer / 1048576)} MB`, 'a Final 3D Scene needs 8+ storage buffers per shader stage: update Chrome or the graphics driver');
    } catch (e) {
      add('browser starts headless', false, String(e.message || e).split('\n')[0], 'check that Chrome opens on this computer');
    }
  }
  if (flags.json) console.log(JSON.stringify({ version: VERSION, ok: checks.every((c) => c.ok), checks, plugin3d: found3d ? { version: found3d.version, from: found3d.from, dir: found3d.world } : null, range3d: RANGE3D }, null, 2));
  else {
    for (const c of checks) console.log(`${c.ok ? 'ok  ' : 'FIX '} ${c.name.padEnd(28)} ${c.detail}${c.fix ? `\n      → ${c.fix}` : ''}`);
    console.log(checks.every((c) => c.ok) ? '\nready' : '\nfix the lines marked FIX');
  }
  process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
}

function init() {
  const dir = rest[0];
  if (!dir) fail('init needs a folder', 'npx greenlight-motion init my-video');
  if (existsSync(path.join(dir, 'project.json')) && !flags.force) fail(`${dir} already has a project.json`, 'pass --force to replace it');
  mkdirSync(path.join(dir, 'assets'), { recursive: true });
  const source = flags.from ? path.resolve(String(flags.from)) : path.join(PKG, 'examples', 'starter', 'project.json');
  const project = JSON.parse(readFileSync(source, 'utf8'));
  writeFileSync(path.join(dir, 'project.json'), JSON.stringify(project, null, 2) + '\n');
  writeFileSync(path.join(dir, 'index.html'), indexHtml(project.template?.title || project.name));
  build(dir);
  console.log(`\nnext: edit ${path.join(dir, 'project.json')}, put pictures/video/sound in ${path.join(dir, 'assets')}/ (refer to them as "asset:<file>"),
then: npx greenlight-motion check ${dir}  →  stills ${dir}  →  render ${dir}  (or open index.html)`);
}

async function check() {
  const dir = rest[0] || '.';
  const { missing: unbuilt, project: built } = build(dir, { quiet: true });
  // a 3D Scene: the scene script's own strict check (the same as `script` and the chat connector), and its critique below
  const S = hasWorld(built) ? await import(pathToFileURL(path.join(PKG, 'dist', 'greenlight-motion-script.mjs')).href) : null;
  // a folder `script` made: its Scene is the script's `world`, so fields are named the script's way (world.render.mode)
  const fromScript = existsSync(path.join(dir, 'script.json'));
  const asScript = (t) => (!fromScript || !t ? t : String(t).replace(/(^|`)rig\.(?=[a-z])/g, '$1world.').replace(/(^|`)scene\./g, '$1world.scene.')
    .replace(/(^|`)materials\./g, '$1world.scene.materials.'));
  const result = await withPage(dir, async ({ page, errors, duration }) => {
    const problems = [];
    const notes = [];
    const project = JSON.parse(readFileSync(path.join(dir, 'project.json'), 'utf8'));
    if (S?.validateWorld) {
      for (const ch of project.channels || []) for (const it of ch?.items || []) {
        if (it?.rig?.renderer !== 'world') continue;
        const r = S.validateWorld(it.rig, { path: fromScript && it.id === 'world' ? 'world' : `${it.id}.rig` });
        for (const e of r.errors) problems.push({ code: 'scene', ref: e.path, detail: e.message, fix: 'fix that field (skill/references/video-world3d.md, world3d-schema.json)' });
        for (const w of r.warnings) notes.push({ code: 'scene', ref: w.path, detail: w.message, fix: 'the 3D engine does not use it as written' });
      }
      // what the shot shows, the lights, the picture's numbers: hints naming the field to change (the middle frame)
      const crit = await page.evaluate(async (t) => (window.GreenLightMotion.page.critique ? window.GreenLightMotion.page.critique(t) : null), duration / 2).catch((e) => ({ hints: [{ kind: 'critique', text: `the 3D critique could not run: ${e.message}` }] }));
      for (const h of crit?.hints || []) notes.push({ code: '3d-critique', ref: h.kind, detail: asScript(h.text), fix: h.fix ? `change ${asScript(h.fix)}` : 'see the hint' });
    }
    for (const r of unbuilt) {
      problems.push(r.startsWith('asset:sounds/')
        ? { code: 'missing-file', ref: r, fix: `a cue's sound is downloaded from the GreenLight sound CDN and that failed: check the internet connection and run build again, or put the file at assets/${r.slice(6)}` }
        : /^(motion-engine-unbundled:|\/hdr\/)/.test(r)
          ? { code: 'missing-file', ref: r, fix: `3D presets and lighting are downloaded from the GreenLight CDN and that failed: check the internet connection and run build again, or put the file in assets/${r.startsWith('/hdr/') ? r.slice(1) : `models/${r.split(':')[1]}`}` }
          : { code: 'missing-file', ref: r, fix: `put the file in assets/ (${r.startsWith('asset:') ? r.slice(6) : r.replace(/^\//, '')}) and run build` });
    }
    for (const r of await page.evaluate(() => window.GreenLightMotion.missingAssets())) if (!unbuilt.includes(r)) problems.push({ code: 'missing-file', ref: r, fix: /^(motion-engine-unbundled:|\/hdr\/)/.test(r)
      ? `the engine asked for ${r}: build downloads 3D presets and lighting from the GreenLight CDN — check the internet connection and run build again, or put it in assets/ (models/ for .glb presets, hdr/ for .hdr)`
      : `the engine asked for ${r}: put it in assets/ (models/ for .glb presets, hdr/ for .hdr)` });
    for (const p of await page.evaluate((proj) => window.GreenLightMotion.checkTemplate(proj), project)) problems.push({ code: 'template', detail: p, fix: 'fix project.template.fields' });
    for (const p of await page.evaluate(async (proj) => window.GreenLightMotion.checkSoundCues(await window.GreenLightMotion.normalize(proj)), project)) {
      problems.push({ code: 'sound', detail: p, fix: 'fix project.sounds (npx greenlight-motion schema sounds lists the library)' });
    }
    // a track matte's source is hidden only while a layer that uses it is on screen; outside that it draws as itself
    for (const g of await page.evaluate((proj) => window.GreenLightMotion.matteGaps(proj), project)) {
      problems.push({ code: 'matte-source', ref: g.source,
        detail: `"${g.source}" shows on screen from ${g.from} s to ${g.to} s, when no layer that uses it as a track matte (${g.consumers.join(', ')}) is on screen`,
        fix: `start and end "${g.source}" with the layer it cuts: the engine hides a matte source only while a layer that uses it is on screen` });
    }
    if (!(duration > 0)) problems.push({ code: 'empty', detail: 'the project has no length', fix: 'add layers to channels[].items with clips that have a duration' });
    const blank = [];
    for (const t of parseTimes(duration).slice(0, 4)) {
      const colours = await page.evaluate(async (time) => {
        const src = await window.GreenLightMotion.page.renderFrame(time);
        const img = await new Promise((ok) => { const i = new Image(); i.onload = () => ok(i); i.src = src; });
        const c = document.createElement('canvas'); c.width = 96; c.height = 54;
        const g = c.getContext('2d'); g.drawImage(img, 0, 0, 96, 54);
        const d = g.getImageData(0, 0, 96, 54).data; const set = new Set();
        for (let k = 0; k < d.length; k += 4) set.add((d[k] >> 4) * 256 + (d[k + 1] >> 4) * 16 + (d[k + 2] >> 4));
        return set.size;
      }, t);
      if (colours <= 1) blank.push(t);
    }
    if (blank.length) problems.push({ code: 'blank-frames', times: blank, fix: 'nothing is on screen at these times: check layer timing (items, trimStart/trimEnd) and opacity' });
    // plugins the page carries (assets/plugins/effects|transitions/): each one's own proof, as GreenLight Dash runs it
    await page.waitForTimeout(600);
    for (const p of await page.evaluate(() => window.GreenLightMotion.pluginStatus())) {
      const ref = `plugins/${p.kind}/${p.id}`;
      // a packaged one's own assets/ files are served by the page (frontend/src/motionEngine/assets.js)
      if (p.ok === false) problems.push({ code: 'plugin', ref, detail: p.error, fix: 'fix the package (the message is its compile or draw error) and run check again' });
      else if (p.ok == null) problems.push({ code: 'plugin', ref, detail: 'it did not load', fix: "check the package's exports against the custom-effects / advanced-transitions starter and that its file name is its id" });
    }
    for (const e of errors) problems.push({ code: 'page-error', detail: e, fix: 'a value in project.json the engine cannot use; compare with the references in the skill' });
    // notes: worth a look, not wrong by themselves — text the engine wraps onto more lines than it was written with
    for (const w of await page.evaluate((proj) => window.GreenLightMotion.textWraps?.(proj) || [], project)) {
      notes.push({ code: 'text-wraps', ref: w.id, rows: w.rows, written: w.written,
        detail: `"${w.text}" (${w.fontPx} px) wraps onto ${w.rows} lines in its ${w.widthPx} px box, written as ${w.written}`,
        fix: `if the break is wanted, write it into the text (\\n); if not, widen the box (textWidthPx, or the script's width) or lower the size` });
    }
    return { ok: problems.length === 0, duration, problems, notes };
  });
  if (flags.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(result.ok ? `ok — ${result.duration.toFixed(2)} s, nothing to fix` : `${result.problems.length} problem(s):`);
    for (const p of result.problems) console.log(`- ${p.code}: ${p.ref || p.detail || (p.times || []).join(', ')}\n  → ${p.fix}`);
    for (const n of result.notes || []) console.log(`note — ${n.code} ${n.ref}: ${n.detail}\n  → ${n.fix}`);
  }
  process.exitCode = result.ok ? 0 : 1;
}

async function stills() {
  const dir = rest[0] || '.';
  const out = path.resolve(String(flags.out || path.join(dir, 'stills')));
  mkdirSync(out, { recursive: true });
  const written = await withPage(dir, async ({ page, duration }) => {
    const times = parseTimes(duration);
    const frames = [];
    for (const t of times) {
      const png = await page.evaluate((x) => window.GreenLightMotion.page.renderFrame(x), t);
      const file = path.join(out, `frame_${t.toFixed(2).replace('.', '_')}s.png`);
      writeFileSync(file, Buffer.from(png.split(',')[1], 'base64'));
      frames.push({ t, file, png });
    }
    // A labelled contact sheet: one picture to look at, the time on every frame.
    const sheet = await page.evaluate(async (list) => {
      const imgs = await Promise.all(list.map((f) => new Promise((ok) => { const i = new Image(); i.onload = () => ok(i); i.src = f.png; })));
      const cols = Math.min(4, imgs.length); const rows = Math.ceil(imgs.length / cols);
      const w = 480; const h = Math.round((w * imgs[0].height) / imgs[0].width); const pad = 8; const label = 26;
      const c = document.createElement('canvas'); c.width = cols * (w + pad) + pad; c.height = rows * (h + label + pad) + pad;
      const g = c.getContext('2d'); g.fillStyle = '#16191b'; g.fillRect(0, 0, c.width, c.height);
      imgs.forEach((img, i) => {
        const x = pad + (i % cols) * (w + pad); const y = pad + Math.floor(i / cols) * (h + label + pad);
        g.drawImage(img, x, y, w, h);
        g.fillStyle = '#e8ecea'; g.font = '600 15px system-ui, sans-serif'; g.fillText(`${list[i].t.toFixed(2)} s`, x + 2, y + h + 19);
      });
      return c.toDataURL('image/png');
    }, frames.map(({ t, png }) => ({ t, png })));
    const sheetFile = path.join(out, 'contact-sheet.png');
    writeFileSync(sheetFile, Buffer.from(sheet.split(',')[1], 'base64'));
    return { frames: frames.map(({ t, file }) => ({ t, file })), sheet: sheetFile };
  });
  if (flags.json) console.log(JSON.stringify(written, null, 2));
  else console.log(`${written.frames.length} frame(s) + contact sheet → ${written.sheet}\nLOOK at the contact sheet before you hand the video over.`);
}

async function render() {
  const dir = rest[0] || '.';
  const fps = Number(flags.fps) === 60 ? 60 : 30;
  const project = readProject(dir);
  const name = (project.template?.title || project.name || 'video').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'video';
  const out = path.resolve(String(flags.out || path.join(dir, `${name}.mp4`)));
  const t0 = Date.now();
  const volume = flags.volume === undefined ? 100 : Number(flags.volume);
  if (!Number.isFinite(volume) || volume < 0 || volume > 100) fail('--volume is a percentage, 0–100');
  const mix = { volume, sfx: !flags['no-sfx'] };
  const res = await withPage(dir, ({ page }) => page.evaluate(({ fps: f, mb, m }) => window.GreenLightMotion.page.renderVideo({ fps: f, motionBlur: mb, ...m }),
    { fps, mb: Boolean(flags['motion-blur']), m: mix }));
  writeFileSync(out, Buffer.from(res.base64, 'base64'));
  const sound = `${mix.volume !== 100 ? `, sound ${mix.volume}%` : ''}${mix.sfx ? '' : ', no sound effects'}`;
  console.log(`rendered ${out} — ${fps} fps${res.motionBlur ? ', motion blur' : ''}${sound}, ${(res.size / 1048576).toFixed(2)} MB, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  // frames the render drew again because their first picture was not whole (a blank Scene picture, a lost GPU device, an unfinished
  // Final trace): the file is whole; this says it happened
  if (res.frameGuard) console.log(`frames drawn again: ${res.frameGuard.retries} (${Object.entries(res.frameGuard.byReason || {}).map(([k, n]) => `${k} ${n}`).join(', ')}); frames ${[...new Set((res.frameGuard.events || []).map((e) => e.frame))].join(', ')}`);
}

function pack() {
  const dir = rest[0] || '.';
  const { project, assets, aliases, missing } = build(dir, { quiet: true });
  if (flags.glvideo) {
    // the project folder in one zip (cli/glvideo.mjs): project.json + every file under assets/
    const title = project.template?.title || project.name;
    const files = filesUnder(path.join(dir, 'assets')).map((rel) => ({ rel, data: readFileSync(path.join(dir, 'assets', ...rel.split('/'))) }));
    const out = path.resolve(String(typeof flags.out === 'string' ? flags.out : path.join(dir, `${(title || 'video').replace(/[^\w-]+/g, '-')}.glvideo`)));
    const bytes = glvideoBytes({ title, project, files });
    writeFileSync(out, bytes);
    console.log(`packed ${out} — ${(bytes.length / 1048576).toFixed(1)} MB, ${files.length} file(s). Double-clicked, it opens in GreenLight Dash as a new video project.`);
    if (missing.length) console.log(`missing (not inside): ${missing.join(', ')}`);
    return;
  }
  if (hasWorld(project)) {
    fail('a video with a 3D Scene does not fit in one HTML file (its 3D engine is the 3D plugin: ~19 MB of files it loads as modules)',
      `render the MP4: npx greenlight-motion render ${dir} — or show the folder: npx greenlight-motion review ${dir} — or --glvideo for GreenLight Dash`);
  }
  const out = path.resolve(String(flags.out || path.join(dir, `${(project.template?.title || project.name || 'video').replace(/[^\w-]+/g, '-')}.html`)));
  const engine = readFileSync(ENGINE, 'utf8');
  // Function replacers: a replacement STRING would expand $&, $' and $` — and minified code is full of them.
  const html = indexHtml(project.template?.title || project.name)
    .replace('<script src="greenlight-motion.js"></script>', () => `<script>${scriptSafe(engine)}</script>`)
    .replace('<script src="project.js"></script>', () => `<script>window.GL_PROJECT = ${scriptSafe(JSON.stringify(project))};</script>`)
    .replace('<script src="assets.js"></script>', () => `<script>${assetsJs(assets, aliases)}</script>`);
  writeFileSync(out, html);
  const mb = Buffer.byteLength(html) / 1048576;
  console.log(`packed ${out} — ${mb.toFixed(1)} MB${mb > 16 ? ' (over 16 MB: too big for a Claude artifact; move large media out or shorten it)' : ''}`);
  if (missing.length) console.log(`missing (not inside): ${missing.join(', ')}`);
}

function set() {
  const dir = rest[0] || '.';
  const project = readProject(dir);
  const fields = new Map((project.template?.fields || []).map((f) => [f.key, f]));
  const values = { ...(project.template?.values || {}) };
  for (const pair of rest.slice(1)) {
    const eq = pair.indexOf('=');
    if (eq < 1) fail(`"${pair}" is not key=value`);
    const key = pair.slice(0, eq);
    if (!fields.has(key)) fail(`the template has no field "${key}"`, `fields: ${[...fields.keys()].join(', ') || 'none'}`);
    const raw = pair.slice(eq + 1);
    values[key] = fields.get(key).type === 'number' ? Number(raw) : fields.get(key).type === 'toggle' ? raw === 'true' : raw;
  }
  project.template = { ...project.template, values };
  writeFileSync(path.join(dir, 'project.json'), JSON.stringify(project, null, 2) + '\n');
  build(dir, { quiet: true });
  console.log(`set ${Object.keys(values).length} value(s); rebuilt ${path.join(dir, 'index.html')}`);
}

// An atomic batch of edits (cli/apply.mjs): every edit checked, all or nothing, then the page is rebuilt.
async function apply() {
  const dir = rest[0] || '.';
  const src = rest[1];
  if (!src) fail('which edits?', 'npx greenlight-motion apply <dir> edits.json   (or - to read them from stdin)');
  let raw;
  if (src === '-') {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    raw = Buffer.concat(chunks).toString('utf8');
  } else {
    if (!existsSync(src)) fail(`no file ${src}`);
    raw = readFileSync(src, 'utf8');
  }
  let edits;
  try { edits = JSON.parse(raw); } catch (e) { return fail(`the edits are not valid JSON: ${e.message}`); }
  const project = readProject(dir);
  let res;
  try {
    res = applyEdits(project, edits);
  } catch (e) {
    if (flags.json) {
      console.log(JSON.stringify({ ok: false, edit: e.index >= 0 ? e.index + 1 : null, error: e.message, hint: e.hint, problems: e.problems || [] }));
      process.exit(1);
    }
    for (const p of (e.problems || []).slice(1)) console.error(`  also: ${p.message}${p.hint ? ` → ${p.hint}` : ''}`);
    return fail(`${e.message} — nothing was changed`, e.hint);
  }
  if (!flags['dry-run']) {
    writeFileSync(path.join(dir, 'project.json'), JSON.stringify(res.project, null, 2) + '\n');
    build(dir, { quiet: true });
  }
  if (flags.json) console.log(JSON.stringify({ ok: true, applied: res.summary.length, summary: res.summary, written: !flags['dry-run'] }));
  else {
    console.log(`${flags['dry-run'] ? 'would apply' : 'applied'} ${res.summary.length} edit(s)${flags['dry-run'] ? ' (dry run — nothing written)' : `; rebuilt ${path.join(dir, 'index.html')}`}`);
    for (const line of res.summary) console.log(`- ${line}`);
  }
}

// ── the scene script: <dir>/script.json → <dir>/project.json, with the converter the GreenLight Motion connector's
// build_video uses (dist/greenlight-motion-script.mjs — frontend/src/motionEngine/sceneScript.js; the format:
// skill/references/scene-script.md). The script is the source: project.json is rewritten on every run, so a project
// edited by hand since then is kept unless --force.
async function script() {
  const dir = rest[0];
  if (!dir) fail('script needs a folder', 'npx greenlight-motion script my-video  (it reads my-video/script.json)');
  const S = await import(pathToFileURL(path.join(PKG, 'dist', 'greenlight-motion-script.mjs')).href);
  const from = flags.from ? path.resolve(String(flags.from)) : path.join(dir, 'script.json');
  if (!existsSync(from)) fail(`no scene script at ${from}`, 'write one (skill/references/scene-script.md) or pass --from <file.json>');
  let scene;
  try { scene = JSON.parse(readFileSync(from, 'utf8')); } catch (e) { fail(`${from} is not valid JSON: ${e.message}`); }
  const projectFile = path.join(dir, 'project.json');
  const stamp = path.join(dir, '.script-built');   // the sha256 of the project.json the last run wrote
  if (existsSync(projectFile) && !flags.force) {
    const now = createHash('sha256').update(readFileSync(projectFile)).digest('hex');
    const built = existsSync(stamp) ? readFileSync(stamp, 'utf8').trim() : '';
    if (now !== built) fail(`${projectFile} ${built ? 'was edited since script wrote it' : 'was not written by script'}`, 'pass --force to replace it (its own edits are lost), or go on editing project.json with apply');
  }
  mkdirSync(path.join(dir, 'assets'), { recursive: true });
  if (path.resolve(from) !== path.resolve(dir, 'script.json')) writeFileSync(path.join(dir, 'script.json'), JSON.stringify(scene, null, 2) + '\n');
  // every src: a file in assets/ (asset:<name>), a file on this computer (copied in) or an https link (downloaded in,
  // so the folder plays offline and the engine may draw it) — its kind and size read from its own bytes
  const files = new Map(); const problems = [];
  for (const src of S.scriptSources(scene)) {
    try { files.set(src, await scriptFile(S, dir, src)); } catch (e) { problems.push(`src "${String(src).slice(0, 80)}": ${e.message}`); }
  }
  const caps = JSON.parse(readFileSync(path.join(PKG, 'schema', 'capabilities.json'), 'utf8'));
  const out = S.compileScript(scene, caps, files);
  out.problems.unshift(...problems);
  for (const w of out.warnings) console.log(`warning: ${w}`);
  if (out.problems.length) {
    console.error(`greenlight-motion: the script can't be converted yet — fix these and run script again:\n${out.problems.map((p) => `  - ${p}`).join('\n')}`);
    process.exit(1);
  }
  const text = JSON.stringify(out.project, null, 2) + '\n';
  writeFileSync(projectFile, text);
  writeFileSync(stamp, createHash('sha256').update(text).digest('hex') + '\n');
  build(dir);
  console.log(`\n${out.duration} s, ${out.summary.length} scene${out.summary.length === 1 ? '' : 's'}:\n${out.summary.join('\n')}
\nnext: npx greenlight-motion check ${dir}  →  stills ${dir} (look at the contact sheet, fix script.json, run script again)  →  render ${dir}`);
}
async function scriptFile(S, dir, src) {
  const take = (bytes, name) => {
    const type = S.sniff(bytes);
    if (!type) throw new Error('not a picture, video or sound the engine plays (PNG, JPEG, GIF, WebP, SVG, MP4, MOV, WebM, MP3, M4A, WAV, OGG)');
    const kind = S.KIND[type];
    if (bytes.length > S.LIMITS[kind]) throw new Error(`the ${kind} is ${Math.round(bytes.length / 1048576)} MB (up to ${S.LIMITS[kind] / 1048576} MB)`);
    return { url: `asset:${name}`, kind, type, name, ...S.probe(bytes, type) };
  };
  const into = (name, bytes) => {   // a file brought in: under its own name, or a numbered one if a different file has it
    const base = path.basename(name).replace(/[^\w.-]+/g, '-') || 'file';
    let n = base;
    for (let i = 2; existsSync(path.join(dir, 'assets', n)) && !readFileSync(path.join(dir, 'assets', n)).equals(bytes); i += 1) n = base.replace(/(\.\w+)?$/, `-${i}$1`);
    writeFileSync(path.join(dir, 'assets', n), bytes);
    return n;
  };
  if (/^asset:/i.test(src)) {
    const name = src.replace(/^asset:/i, '');
    const file = path.join(dir, 'assets', name);
    if (!existsSync(file)) throw new Error(`put the file at ${file}`);
    return take(readFileSync(file), name);
  }
  if (/^https?:\/\//i.test(src)) {
    const r = await fetch(src, { redirect: 'follow', signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error(`the link answered ${r.status}`);
    const bytes = Buffer.from(await r.arrayBuffer());
    let name = 'file';
    try { name = decodeURIComponent(new URL(r.url || src).pathname.split('/').pop() || 'file'); } catch { /* the default */ }
    const type = S.sniff(bytes);
    if (type && !new RegExp(`\\.${type === 'jpg' ? 'jpe?g' : type}$`, 'i').test(name)) name = `${name.replace(/\.\w*$/, '') || 'file'}.${type}`;
    return take(bytes, into(name, bytes));
  }
  const local = path.resolve(src);
  if (!existsSync(local)) throw new Error(`no such file — put it in ${path.join(dir, 'assets')}/ and write "asset:<file name>"`);
  const bytes = readFileSync(local);
  return take(bytes, into(path.basename(local), bytes));
}

function schema() {
  const topic = rest[0] || 'format';
  const caps = () => JSON.parse(readFileSync(path.join(PKG, 'schema', 'capabilities.json'), 'utf8'));
  const show = (v) => console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
  switch (topic) {
    case 'format': {
      const refs = path.join(PKG, 'skill', 'references');
      const essentials = readFileSync(path.join(PKG, 'skill', 'SKILL.md'), 'utf8').split('## The project format — essentials')[1]?.split('\n## ')[0];
      if (essentials) show(`# The project format — essentials${essentials.trimEnd()}\n`);
      show(`The project format is the GreenLight Dash Video Editor's. Read:
  ${path.join(PKG, 'skill', 'SKILL.md')}            how to work, and the essentials
  ${refs}/            one file per topic: ${existsSync(refs) ? readdirSync(refs).map((f) => f.replace('.md', '')).join(', ') : '(missing)'}
Machine-readable: npx greenlight-motion schema effects | transitions | easings | paths | expressions | sounds | template`);
      break;
    }
    case 'template': show(readFileSync(path.join(PKG, 'skill', 'SKILL.md'), 'utf8').split('## Template')[1]?.split('\n## ')[0] || 'see SKILL.md'); break;
    case 'effects': show(caps().effects); break;
    case 'transitions': show(caps().transitions); break;
    case 'easings': show(caps().easings); break;
    case 'paths': show(caps().paths); break;
    case 'expressions': show(caps().keyframeExpressions); break;
    case 'sounds': show(caps().sounds); break;
    default: fail(`unknown topic "${topic}"`, 'format | template | effects | transitions | easings | paths | expressions | sounds');
  }
}

// Motion data: every keyframed layer's animated values per frame + its moments (start, end, peak, settles).
async function trace() {
  const dir = rest[0] || '.';
  build(dir, { quiet: true });
  const fps = Number(flags.fps) || 30;
  const only = flags.items ? String(flags.items).split(',') : null;
  const data = await withPage(dir, ({ page }) => page.evaluate(async ([f, items]) => {
    const project = window.GL_PROJECT;
    return window.GreenLightMotion.trace(project, { fps: f, items });
  }, [fps, only]));
  const out = flags.out ? path.resolve(String(flags.out)) : path.join(dir, 'trace.json');
  writeFileSync(out, JSON.stringify(data, null, 1));
  if (flags.json) console.log(JSON.stringify(data));
  else {
    console.log(`traced ${data.layers.length} animated layer(s) at ${fps} fps → ${out}`);
    for (const l of data.layers) {
      console.log(`- ${l.id} (${l.type}) ${l.start}–${l.end} s · tracks ${Object.keys(l.tracks).join(', ')} · peak ${l.moments.peak ?? '—'} s`);
    }
  }
}

// The event timeline (frontend/src/motionEngine/events.js): every move's fastest moment and its stop, appearances, cuts, transitions, text
// letters arriving, a Scene's switches, lights and sims, from the project's own data with no browser and no render; the moments a sound
// lands on. A project with a 3D Scene is read by the 3D plugin's timeline (its world3d-events.mjs), one without by this package's own.
function events() {
  const dir = rest[0] || '.';
  const project = readProject(dir);
  const bundle = hasWorld(project) ? path.join(plugin3d({ quiet: !!flags.json }).world, 'world3d-events.mjs') : path.join(PKG, 'dist', 'greenlight-motion-events.mjs');
  if (!existsSync(bundle)) fail(`no event timeline at ${bundle}`, hasWorld(project) ? 'update the 3D plugin: npx greenlight-motion add-3d' : 'reinstall greenlight-motion');
  const fps = flags.fps ? Number(flags.fps) : undefined;
  const r = spawnSync(process.execPath, [bundle], { input: JSON.stringify({ project, fps }), maxBuffer: 1 << 28 });
  if (r.status !== 0) fail(`the event timeline failed: ${String(r.stderr || '').slice(-600)}`);
  const out = flags.out ? path.resolve(String(flags.out)) : path.join(dir, 'events.json');
  const data = JSON.parse(r.stdout.toString('utf8'));
  writeFileSync(out, JSON.stringify(data, null, 1) + '\n');
  if (flags.json) { console.log(r.stdout.toString('utf8')); return; }
  const by = {};
  for (const e of data.events) by[e.kind] = (by[e.kind] || 0) + 1;
  console.log(`${data.events.length} events over ${data.duration} s at ${data.fps} fps → ${out}`);
  console.log(Object.entries(by).map(([k, n]) => `${k} ${n}`).join(' · '));
  for (const e of data.events.filter((x) => x.strength >= 0.3 && x.kind !== 'text').slice(0, 40)) {
    console.log(`- f${e.frame} ${e.t} s  ${e.kind}${e.channel ? ` (${e.channel})` : ''}${e.what ? ` ${e.what}` : ''}  ${e.name}  strength ${e.strength}${e.pan !== undefined ? `  pan ${e.pan}` : ''}`);
  }
  for (const n of data.notes || []) console.log(`note: ${n}`);
}

// The page served on this computer for the user's review (`localhost`, nothing leaves it): one film or several, the
// engine's studio (cli/compare.mjs). Save for agent writes <dir>/review/ (the first folder's, or --out's): notes.json,
// NOTES.md (what the agent reads) and a picture of every noted moment with the user's drawing on it.
async function review() {
  return (await import('./compare.mjs')).compare({ dirs: rest.length ? rest : ['.'], flags,
    ctx: { build, readProject, filesUnder, assetKeys, hasWorld, launch, serveFolder, ENGINE, fail } });
}

// The 3D plugin now, before a video needs it (a scene built from zero, an offline day ahead)
function add3d() {
  const p = plugin3d({ quiet: !!flags.json });
  if (flags.json) console.log(JSON.stringify({ ok: true, package: NAME3D, version: p.version, from: p.from, dir: p.world, range: RANGE3D }));
  else console.log(`3D plugin ${NAME3D} ${p.version} ready (${p.from}): ${p.world}`);
}

// (chatfarm2) a render part on a GPU machine the user owns, driven from the user's page (cli/podServe.mjs)
const podServe = async () => (await import('./podServe.mjs')).podServe({ build, serveFolder, findChrome, require, VERSION, flags });
// a pick page for generated pictures (cli/pick.mjs)
const pick = async () => (await import('./pick.mjs')).pick({ dir: rest[0] || '.', flags, ctx: { fail, PKG } });
const COMMANDS = { doctor, init, script, build: () => build(rest[0] || '.'), check, stills, render, pack, set, apply, schema, trace, events, review, pick, 'add-3d': add3d, 'pod-serve': podServe };
if (!cmd || cmd === 'help' || flags.help || !COMMANDS[cmd]) {
  // the help is this file's opening comment (every line after the #! up to the first that is not a comment)
  const head = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1);
  console.log(head.slice(0, head.findIndex((l) => !l.startsWith('//'))).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(cmd && !COMMANDS[cmd] && cmd !== 'help' ? 1 : 0);
}
try {
  await COMMANDS[cmd]();
} catch (e) {
  fail(e?.message || String(e));
}
