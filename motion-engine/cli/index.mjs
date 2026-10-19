#!/usr/bin/env node
// greenlight-motion — the GreenLight Motion Engine's command line, for AI agents (skill/SKILL.md).
//
//   npx greenlight-motion doctor                     what this computer has, and how to fix what's missing
//   npx greenlight-motion init <dir> [--from p.json] a project folder: index.html, project.json, assets/
//   npx greenlight-motion build <dir>                project.json + assets/ → a page the user double-clicks
//   npx greenlight-motion check <dir> [--json]       problems to fix (missing files, template, errors, blank frames)
//   npx greenlight-motion stills <dir> [--at 0.5,2] [--count 6] [--out d]   PNG frames + a labelled contact sheet
//   npx greenlight-motion render <dir> [--fps 60] [--motion-blur] [--volume 80] [--no-sfx] [--out f.mp4]
//   npx greenlight-motion pack <dir> [--out f.html]  everything in ONE html file (share it, or put it in a Claude artifact)
//   npx greenlight-motion pack <dir> --glvideo [--out f.glvideo]   ONE .glvideo file: double-clicked, it opens in GreenLight Dash
//   npx greenlight-motion set <dir> key=value …      template values (what the page's options panel changes)
//   npx greenlight-motion apply <dir> <edits.json|-> [--dry-run] [--json]   an atomic, validated batch of edits (cli/apply.mjs)
//   npx greenlight-motion trace <dir> [--fps 30] [--items a,b] [--out f.json]   every keyframed layer's values per frame + its moments
//   npx greenlight-motion review <dir> [--port 4810] [--open]   the page for the user's review: the notes they mark on it land in <dir>/review/
//   npx greenlight-motion schema [topic]             the project format (format | template | effects | transitions | easings | paths | expressions | sounds)
//
// Needs Node 18+ and Chrome or Edge (the engine draws with WebGPU; a headless *shell* has no WebGPU, so the CLI
// drives the real browser in its new headless mode). No ffmpeg: the page encodes the MP4 itself.
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, copyFileSync, rmSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { applyEdits } from './apply.mjs';
import { glvideoBytes } from './glvideo.mjs';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const ENGINE = path.join(PKG, 'dist', 'greenlight-motion.js');
const VERSION = JSON.parse(readFileSync(path.join(PKG, 'package.json'), 'utf8')).version;

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
<script>GreenLightMotion.mountPage(document.getElementById('app'), { project: window.GL_PROJECT, assets: window.GL_ASSETS });</script>
`;
// JSON inside a <script>: no "</script", no "<!--" (both escapes stay valid JSON and JS, so the app can read a page back)
const scriptSafe = (s) => s.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\u0021--');

const assetsJs = (assets, aliases) => `window.GL_ASSETS = ${scriptSafe(JSON.stringify(assets))};
window.GL_ASSET_ALIASES = ${scriptSafe(JSON.stringify(aliases))};
(function (a, m) { for (var k in m) if (!(k in a)) a[k] = a[m[k]]; })(window.GL_ASSETS, window.GL_ASSET_ALIASES);
`;

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

function build(dir, { quiet = false } = {}) {
  if (!existsSync(ENGINE)) fail('the engine bundle is missing from this package', 'reinstall greenlight-motion');
  const project = readProject(dir);
  const soundsMissing = [...ensureSoundFiles(dir, project), ...ensure3dFiles(dir, project)];
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
  writeFileSync(path.join(dir, 'assets.js'), assetsJs(assets, aliases));
  copyFileSync(ENGINE, path.join(dir, 'greenlight-motion.js'));
  if (!existsSync(path.join(dir, 'index.html'))) writeFileSync(path.join(dir, 'index.html'), indexHtml(project.template?.title || project.name));
  if (!quiet) {
    console.log(`built ${path.join(dir, 'index.html')} — ${filesUnder(path.join(dir, 'assets')).length} file(s), ${(bytes / 1048576).toFixed(1)} MB of assets`);
    if (missing.length) console.log(`missing (put them in assets/): ${missing.join(', ')}`);
  }
  return { project, assets, aliases, missing, bytes };
}

// The page, headless: built, opened from file://, settled (files are asked for in waves — a model, then its HDR).
async function withPage(dir, fn) {
  build(dir, { quiet: true });
  const browser = await launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e.message || e)));
    await page.goto('file://' + path.resolve(dir, 'index.html'));
    await page.waitForFunction(() => window.GreenLightMotion?.page?.ready, null, { timeout: 90000 });
    const duration = await page.evaluate(() => window.GreenLightMotion.page.duration);
    for (const t of [0, duration / 2, Math.max(0, duration - 0.05)]) await page.evaluate((x) => window.GreenLightMotion.page.renderFrame(x), t);
    await page.waitForTimeout(600);
    return await fn({ page, errors, duration });
  } finally {
    await browser.close();
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
  if (chrome) {
    try {
      const browser = await launch();
      const page = await browser.newPage();
      // WebGPU and WebCodecs exist only in a secure context: a file:// page is one, about:blank is not.
      await page.goto(pathToFileURL(path.join(PKG, 'package.json')).href);
      const gpu = await page.evaluate(async () => {
        const a = await navigator.gpu?.requestAdapter();
        const h264 = typeof VideoEncoder === 'function' && (await VideoEncoder.isConfigSupported({ codec: 'avc1.640028', width: 1920, height: 1080, bitrate: 8e6, framerate: 30 })).supported;
        return { webgpu: !!a, adapter: a?.info ? [a.info.vendor, a.info.architecture].filter(Boolean).join(' ') : '', h264 };
      });
      await browser.close();
      add('WebGPU (headless)', gpu.webgpu, gpu.adapter || (gpu.webgpu ? 'adapter' : 'no adapter'), 'update Chrome; on Linux servers WebGPU needs Vulkan or SwiftShader');
      add('H.264 encoding (WebCodecs)', gpu.h264, gpu.h264 ? 'supported' : 'not supported', 'use Google Chrome (open-source Chromium on Linux lacks H.264)');
    } catch (e) {
      add('browser starts headless', false, String(e.message || e).split('\n')[0], 'check that Chrome opens on this computer');
    }
  }
  if (flags.json) console.log(JSON.stringify({ version: VERSION, ok: checks.every((c) => c.ok), checks }, null, 2));
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
  const { missing: unbuilt } = build(dir, { quiet: true });
  const result = await withPage(dir, async ({ page, errors, duration }) => {
    const problems = [];
    const project = JSON.parse(readFileSync(path.join(dir, 'project.json'), 'utf8'));
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
    return { ok: problems.length === 0, duration, problems };
  });
  if (flags.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(result.ok ? `ok — ${result.duration.toFixed(2)} s, nothing to fix` : `${result.problems.length} problem(s):`);
    for (const p of result.problems) console.log(`- ${p.code}: ${p.ref || p.detail || (p.times || []).join(', ')}\n  → ${p.fix}`);
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

function schema() {
  const topic = rest[0] || 'format';
  const caps = () => JSON.parse(readFileSync(path.join(PKG, 'schema', 'capabilities.json'), 'utf8'));
  const show = (v) => console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
  switch (topic) {
    case 'format': {
      const refs = path.join(PKG, 'skill', 'references');
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

// The page served on this computer for the user's review (`localhost`, nothing leaves it). The notes they mark on the
// frame — each a pin, box, arrow or drawing with their words, the moment and the layers under it — are written to
// <dir>/review/: notes.json, NOTES.md (what the agent reads) and a picture of each moment with the marks numbered.
async function review() {
  const dir = path.resolve(rest[0] || '.');
  build(dir, { quiet: true });
  const http = await import('node:http');
  const out = path.join(dir, 'review');
  const types = { ...MIME, '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.md': 'text/markdown; charset=utf-8' };
  const send = (res, code, body, type = 'application/json') => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
  };
  const body = (req) => new Promise((ok, no) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => ok(Buffer.concat(chunks)));
    req.on('error', no);
  });
  const server = http.createServer(async (req, res) => {
    try {
      const p = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (p === '/__glm/review') {
        if (req.method === 'GET') {
          const f = path.join(out, 'notes.json');
          return send(res, 200, existsSync(f) ? readFileSync(f) : JSON.stringify({ notes: [] }));
        }
        if (req.method === 'PUT') {
          const j = JSON.parse((await body(req)).toString('utf8'));
          mkdirSync(out, { recursive: true });
          writeFileSync(path.join(out, 'notes.json'), JSON.stringify({ notes: Array.isArray(j.notes) ? j.notes : [] }, null, 1));
          writeFileSync(path.join(out, 'NOTES.md'), String(j.markdown || ''));
          console.log(`${new Date().toLocaleTimeString()}  ${(j.notes || []).length} note(s) → ${path.join(out, 'NOTES.md')}`);
          return send(res, 200, '{"ok":true}');
        }
      }
      const img = /^\/__glm\/review\/image\/(at-[\d.]+s\.png)$/.exec(p);
      if (img) {
        const f = path.join(out, img[1]);
        if (req.method === 'PUT') { mkdirSync(out, { recursive: true }); writeFileSync(f, await body(req)); return send(res, 200, '{"ok":true}'); }
        if (req.method === 'DELETE') { rmSync(f, { force: true }); return send(res, 200, '{"ok":true}'); }
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'not allowed', 'text/plain');
      const file = path.resolve(dir, p === '/' ? 'index.html' : p.replace(/^\/+/, ''));
      if (!file.startsWith(dir + path.sep) || !existsSync(file) || statSync(file).isDirectory()) return send(res, 404, 'not found', 'text/plain');
      return send(res, 200, readFileSync(file), types[path.extname(file).toLowerCase()] || 'application/octet-stream');
    } catch (e) {
      return send(res, 500, JSON.stringify({ error: String(e?.message || e) }));
    }
  });
  const port = flags.port !== undefined ? Number(flags.port) : 4810;
  await new Promise((ok, no) => { server.once('error', no); server.listen(port, '127.0.0.1', ok); });
  const url = `http://127.0.0.1:${server.address().port}/`;
  console.log(`review: ${url}\n  Open it in Chrome or Edge. Notes marked on the page land in ${out}/ (NOTES.md, notes.json, a picture of each moment).\n  Ctrl+C to stop.`);
  if (flags.open) {
    const opener = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
    spawn(opener[0], opener[1], { stdio: 'ignore', detached: true }).unref();
  }
  await new Promise(() => {});   // serves until stopped
}

const COMMANDS = { doctor, init, build: () => build(rest[0] || '.'), check, stills, render, pack, set, apply, schema, trace, review };
if (!cmd || cmd === 'help' || flags.help || !COMMANDS[cmd]) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 19).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(cmd && !COMMANDS[cmd] && cmd !== 'help' ? 1 : 0);
}
try {
  await COMMANDS[cmd]();
} catch (e) {
  fail(e?.message || String(e));
}
