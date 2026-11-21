// greenlight-motion pod-serve — a render part on a GPU machine the USER owns (a RunPod pod, any Linux box with an NVIDIA GPU), driven
// straight from the user's own page: the page sends the project and its files here, asks for a range of frames, and downloads the MP4
// part; nothing passes any server of ours. One job per process: its parts in turn on ONE page (0.5.6: the browser, the page and its
// player stay warm between the parts of the same project — a new PUT of the project or a file, a failed part or the end closes them).
//
//   npx greenlight-motion@<exact> pod-serve [--port 8080]
//   env: GL_POD_TOKEN (required: the job's secret; every route but /health wants "Authorization: Bearer <it>"),
//        GL_POD_BUDGET_S (the pod's hard limit, default 3600 s), GL_POD_IDLE_S (no word from the page for this long ends the pod, 600),
//        RUNPOD_POD_ID + RUNPOD_API_KEY (RunPod injects them: the pod ends ITSELF with DELETE /v2/pods/<id>; elsewhere the process exits)
//
//   GET    /health                    { ok, version, state }                        (no token: the page waits for it)
//   PUT    /project                   project.json
//   PUT    /files/<name>              one of the project's files (asset:<name>), ≤ the proxy's request size (120 MB measured)
//   POST   /render  { start, end, fps, motionBlur }   frames [start, end) at film time, picture only (the page puts one sound under all parts)
//   GET    /status                    { state, frames, total, firstFrameSec, secPerFrame, error, gpu,
//                                       startup: { pageSec, playerSec, display, displaySec, warm } }
//   GET    /part.mp4                  the part, when done
//   DELETE /self                      end this pod now (also: after /part.mp4 was fetched, 20 s later)
//
// The browser: Chrome on Linux traces on NVIDIA through Vulkan (the switches go last, after Playwright's own); the page's 3D picture needs
// a GPU-composited window, so Chrome runs as a window on Xvfb when it is there (measured: plain headless on a RunPod pod returns the
// Scene transparent, FRAME_EMPTY), else headless. (0.5.6) Xvfb starts with pod-serve and a part waits until it answers (GL_POD_DISPLAY_WAIT_S,
// 30 s); one that never does fails the part (NO_DISPLAY) instead of a headless Chrome whose Scene can only come out transparent.
import http from 'node:http';
import net from 'node:net';
import { existsSync, mkdirSync, chmodSync, writeFileSync, readFileSync, statSync, createReadStream, createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const VULKAN = ['--enable-features=Vulkan', '--use-angle=vulkan', '--disable-vulkan-surface'];
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, PUT, POST, DELETE, OPTIONS', 'access-control-max-age': '600' };

export async function podServe({ build, serveFolder, findChrome, require, VERSION, flags = {} }) {
  const token = process.env.GL_POD_TOKEN;
  if (!token || token.length < 16) throw new Error('set GL_POD_TOKEN (16+ characters): the page that started this pod sends it');
  const port = Number(flags.port || process.env.PORT || 8080);
  const budget = Number(process.env.GL_POD_BUDGET_S || 3600) * 1000;
  const idle = Number(process.env.GL_POD_IDLE_S || 600) * 1000;
  const dir = path.join(os.tmpdir(), `glpod-${process.pid}`);
  mkdirSync(path.join(dir, 'assets'), { recursive: true });
  const job = { state: 'waiting', frames: 0, total: 0, firstFrameSec: null, secPerFrame: null, error: null, gpu: null, startup: null, startedAt: null };
  let last = Date.now();
  const t0 = Date.now();
  let ending = false;
  const log = (m) => console.log(`[pod-serve ${new Date().toISOString().slice(11, 19)}] ${m}`);

  // (0.5.6) THE DISPLAY. 0.5.5 started Xvfb with the first part, looked 10 s for its socket file and, when it was not there by then (on
  // some RunPod hosts Xvfb crashes at once in its GLX extension: engine056's live jobs 1 and 2, EU-SE-1 A40s), launched Chrome HEADLESS
  // without a word; on Linux a headless Chrome hands the page the 3D Scene's picture transparent, so the
  // part failed at its first frame with "[FRAME_EMPTY] … transparent while the world drew 5 objects in view" (live job 6, 2026-11-19: on
  // the two pods that failed, the part sat 11–13 s in 'building' before its page opened; 1.5–2.5 s on the pods that rendered). Now Xvfb
  // starts when pod-serve does (the page's uploads run meanwhile) WITHOUT GLX, a part waits until it ANSWERS (a connection to its socket),
  // and on Linux with Xvfb a part never runs headless: past the wait it fails with Xvfb's own words (NO_DISPLAY), and the page gives the
  // part to another pod.
  const linux = process.platform === 'linux';
  const XVFB = '/usr/bin/Xvfb';
  // Xvfb answers in 0.05–0.2 s on a pod (measured, also under 64 busy loops): 30 s at most, then the part goes to another pod
  const displayWait = Number(process.env.GL_POD_DISPLAY_WAIT_S || 30) * 1000;
  const connects = (where) => new Promise((ok) => {
    const c = net.connect(where);
    c.once('connect', () => { c.destroy(); ok(true); });
    c.once('error', () => ok(false));
  });
  // display n answers on its socket file, or on Linux's abstract socket of the same name (what Chrome's X client tries first; an Xvfb that
  // could not make /tmp/.X11-unix listens there only)
  const answers = async (n) => (await connects(`/tmp/.X11-unix/X${n}`)) || (await connects(`\0/tmp/.X11-unix/X${n}`));
  let display = null;   // a promise of the DISPLAY Chrome uses (null: headless)
  let xvfbSays = '';    // the last of what Xvfb printed (its reason when it ends or never answers), for the log and the part's error
  function startDisplay() {
    if (display) return display;
    display = (async () => {
      if (!linux) return null;
      if (process.env.DISPLAY) return process.env.DISPLAY;
      if (!existsSync(XVFB)) return null;   // a Linux box without Xvfb: headless (a 3D Scene does not hand over there; the frame guard says so)
      const t = Date.now();
      // the folder of the X sockets, as Xvfb wants it (it makes it itself when it can; a box that cannot leaves only the abstract socket)
      try { mkdirSync('/tmp/.X11-unix', { recursive: true, mode: 0o1777 }); chmodSync('/tmp/.X11-unix', 0o1777); } catch { /* not ours to set */ }
      // :99, and when that Xvfb ends at once (a display taken, a stale lock), :100 and :101
      for (const n of [99, 100, 101]) {
        if (await answers(n)) { log(`display :${n} answers (already running)`); return `:${n}`; }
        let exited = null;
        // without GLX: Chrome draws through Vulkan here and never asks the X server for GL, and on some RunPod hosts the X server's GLX
        // (the host's NVIDIA library) crashes it — "(EE) Caught signal 11 (Segmentation fault). Server aborting", at its start or at
        // a client's first connection (engine056: seen on EU-SE-1 A40 pods; such a host with -extension GLX rendered the part)
        const x = spawn(XVFB, [`:${n}`, '-screen', '0', '1920x1080x24', '-nolisten', 'tcp', '-extension', 'GLX'], { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
        x.stderr.on('data', (d) => { xvfbSays = (xvfbSays + d).slice(-1500); });
        x.on('exit', (code, sig) => { exited = `exit ${code ?? sig}`; });
        x.on('error', (e) => { exited = `spawn ${e.code || e.message}`; });
        x.unref(); x.stderr.unref?.();
        while (Date.now() - t < displayWait && !exited) {
          if (await answers(n)) { log(`display :${n} answers ${((Date.now() - t) / 1000).toFixed(1)} s after its start`); return `:${n}`; }
          await new Promise((ok) => setTimeout(ok, 250));
        }
        log(`display :${n}: ${exited || 'no answer'} after ${((Date.now() - t) / 1000).toFixed(1)} s; Xvfb said: ${xvfbSays.trim().split('\n').slice(-4).join(' | ') || '(nothing)'}`);
        if (!exited) break;   // running but never answering: no other number helps
      }
      const said = xvfbSays.trim().split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 240);
      throw Object.assign(new Error(`[NO_DISPLAY] the virtual display (Xvfb) did not answer in ${Math.round((Date.now() - t) / 1000)} s${said ? ` (Xvfb: ${said})` : ''}; a 3D Scene renders only in a windowed Chrome on Linux`), { code: 'NO_DISPLAY' });
    })();
    display.catch(() => { display = null; });   // the next part tries again
    return display;
  }

  async function end(why) {
    if (ending) return;
    ending = true;
    log(`ending: ${why}`);
    // the warm page closes alongside (not waited for: the process ends 0.5 s after the pod's own DELETE, and Playwright ends its browser
    // with the process)
    closeWarm().catch(() => {});
    if (process.env.RUNPOD_POD_ID && process.env.RUNPOD_API_KEY) {
      for (let k = 0; k < 3; k += 1) {
        try {
          const r = await fetch(`https://api.runpod.io/v2/pods/${encodeURIComponent(process.env.RUNPOD_POD_ID)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${process.env.RUNPOD_API_KEY}` } });
          log(`self-delete: HTTP ${r.status}`);   // the status only: never the key, never a message that could carry it
          if (r.ok || r.status === 404) break;
        } catch { log('self-delete: network error'); }
        await new Promise((ok) => setTimeout(ok, 3000));
      }
    }
    setTimeout(() => process.exit(0), 500);
  }
  setInterval(() => {
    if (Date.now() - last > idle) end(`no word from the page for ${Math.round(idle / 1000)} s`);
    else if (Date.now() - t0 > budget) end('the pod\'s time budget');
  }, 10000).unref?.();

  // (0.5.6) WARM PARTS: the browser, the page and its player stay open after a part, for the next part of the same project (no PUT of
  // the project or a file since). 0.5.5 started a fresh Chrome, page and player for every part: a pod's second part paid the first one's
  // warm-up again (25–28 s to its first frame on an A40). A new project or file, a failed part, or the end: closed.
  let warm = null;   // { key, browser, page, served, startup, parts }
  let inputs = 0;    // the project's and its files' PUTs so far: the warm page is for the inputs it was opened with
  async function closeWarm() {
    const w = warm;
    warm = null;
    if (!w) return;
    await w.browser.close().catch(() => {});
    w.served.close();
  }
  async function openPage(key) {
    // (0.5.6) the files the project needs, or the part fails here: build downloads the 3D Scene's lighting and models from the files CDN,
    // and a part built without one rendered WITHOUT the Scene and said nothing (measured: the HDR's download refused → 9 frames of the
    // 2D layers alone, no error). One more try, then the reason.
    let built = build(dir, { quiet: true, sounds: false });
    if (built.missing.length) built = build(dir, { quiet: true, sounds: false });
    if (built.missing.length) throw Object.assign(new Error(`[FILES_MISSING] the project's files did not come: ${built.missing.slice(0, 6).join(', ')}`), { code: 'FILES_MISSING' });
    const shown = Date.now();
    const screen = await startDisplay();
    const displaySec = (Date.now() - shown) / 1000;
    const served = await serveFolder(dir);
    const { chromium } = require('playwright-core');
    const windowed = linux && !!screen;
    let browser = null;
    try {
      browser = await chromium.launch({ executablePath: findChrome(), headless: !windowed, env: { ...process.env, ...(screen ? { DISPLAY: screen } : {}) },
        args: [...(windowed ? ['--ozone-platform=x11'] : ['--headless=new']), '--enable-unsafe-webgpu', ...(linux ? VULKAN : [])] });
      const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
      // the page's progress, for whichever part runs now (one page, its parts in turn)
      await page.exposeFunction('glPodTick', (k) => {
        job.frames = Math.min(job.total, Math.round(k * job.total));
        const s = (Date.now() - job.renderAt) / 1000;
        if (job.frames >= 1 && job.firstFrameSec === null) job.firstFrameSec = s;
        if (job.frames >= 2) job.secPerFrame = (s - job.firstFrameSec) / (job.frames - 1);
      });
      const opened = Date.now();
      await page.goto(`${served.url}index.html`);
      await page.waitForFunction(() => window.GreenLightMotion?.page?.ready, null, { timeout: 180000 });
      // (0.5.5) the page is up before its player (the GPU device, the project's first load): wait for the player, or the engine's own
      // reason why it cannot start. 0.5.4 went straight to renderVideo and found the player null on a cold pod.
      const pageSec = (Date.now() - opened) / 1000;
      await page.evaluate(() => window.GreenLightMotion.page.whenPlayer(180000));
      const startup = { pageSec, playerSec: (Date.now() - opened) / 1000, display: screen || 'headless', displaySec: Math.round(displaySec * 10) / 10 };
      log(`page ready ${pageSec.toFixed(2)} s, player ${startup.playerSec.toFixed(2)} s after opening`);
      job.gpu = await page.evaluate(async () => { const a = await navigator.gpu?.requestAdapter(); return a?.info ? `${a.info.vendor} ${a.info.architecture}${a.info.isFallbackAdapter ? ' (CPU)' : ''}` : 'none'; });
      return { key, browser, page, served, startup, parts: 0 };
    } catch (e) {
      await browser?.close().catch(() => {});
      served.close();
      throw e;
    }
  }

  async function render({ start, end: stop, fps = 30, motionBlur = false }) {
    job.state = 'building';
    job.startedAt = Date.now();
    job.total = Math.max(1, Math.round((stop - start) * fps));
    const key = inputs;
    const reuse = warm && warm.key === key && warm.browser.isConnected() && !warm.page.isClosed();
    if (!reuse) {
      await closeWarm();
      warm = await openPage(key);
    }
    const w = warm;
    job.startup = { ...w.startup, warm: !!reuse };
    if (reuse) log(`part ${w.parts + 1} on the warm page`);
    try {
      job.state = 'rendering';
      job.renderAt = Date.now();
      const res = await w.page.evaluate(({ start, stop, fps, motionBlur }) => window.GreenLightMotion.page.renderVideo({ range: { start, end: stop }, audio: false, elsewhere: true,
        fps, motionBlur, onProgress: (p) => window.glPodTick(Number(p) || 0) }), { start, stop, fps, motionBlur });
      writeFileSync(path.join(dir, 'part.mp4'), Buffer.from(res.base64, 'base64'));
      w.parts += 1;
      job.state = 'done';
      job.frames = job.total || job.frames;
      job.bytes = res.size;
      log(`part done: ${res.size} B, ${((Date.now() - job.renderAt) / 1000).toFixed(1)} s`);
    } catch (e) {
      // a part that failed may have left the page in any state: the next part starts fresh
      await closeWarm();
      throw e;
    }
  }

  const server = http.createServer(async (q, s) => {
    const send = (code, body, type = 'application/json') => { s.writeHead(code, { ...CORS, 'content-type': type }); s.end(typeof body === 'string' ? body : JSON.stringify(body)); };
    try {
      if (q.method === 'OPTIONS') { s.writeHead(204, CORS); return s.end(); }
      const u = new URL(q.url, 'http://pod');
      if (u.pathname === '/health') return send(200, { ok: true, version: VERSION, state: job.state });
      if (q.headers.authorization !== `Bearer ${token}`) return send(401, { error: 'token' });
      last = Date.now();
      if (q.method === 'PUT' && (u.pathname === '/project' || u.pathname.startsWith('/files/'))) {
        if (job.state === 'building' || job.state === 'rendering') return send(409, { error: 'a render is running' });
        const name = u.pathname === '/project' ? 'project.json' : path.basename(decodeURIComponent(u.pathname.slice(7)));
        if (!name || name.startsWith('.')) return send(400, { error: 'name' });
        const f = u.pathname === '/project' ? path.join(dir, 'project.json') : path.join(dir, 'assets', name);
        inputs += 1;
        const w = createWriteStream(f);
        for await (const c of q) w.write(c);
        w.end();
        await new Promise((ok) => w.on('close', ok));
        return send(200, { name, bytes: statSync(f).size });
      }
      if (q.method === 'POST' && u.pathname === '/render') {
        // a pod takes the next part once it has handed over its last one (the page's queue: fewer pods than parts)
        // (0.5.6) the body first, then the check and the start with nothing awaited between them: 0.5.5 checked, then awaited the body,
        // so two POSTs at once (the page retries one the proxy dropped) could both pass and start two renders on one pod
        let b = ''; for await (const c of q) b += c;
        if (job.state === 'building' || job.state === 'rendering') return send(409, { error: `already ${job.state}` });
        if (!existsSync(path.join(dir, 'project.json'))) return send(400, { error: 'no project' });
        let a = null;
        try { a = JSON.parse(b || '{}'); } catch { return send(400, { error: 'json' }); }
        if (!(Number(a.end) > Number(a.start))) return send(400, { error: 'range' });
        Object.assign(job, { state: 'building', frames: 0, total: 0, firstFrameSec: null, secPerFrame: null, error: null, startup: null });
        render({ start: Number(a.start), end: Number(a.end), fps: Number(a.fps) === 60 ? 60 : 30, motionBlur: a.motionBlur === true })
          .catch((e) => { job.state = 'failed'; job.error = String(e?.message || e).slice(0, 400); log(`failed: ${job.error}`); });
        return send(202, { state: 'building' });
      }
      if (u.pathname === '/status') return send(200, { ...job, startedAt: undefined, renderAt: undefined });
      if (u.pathname === '/part.mp4') {
        const f = path.join(dir, 'part.mp4');
        if (job.state !== 'done' || !existsSync(f)) return send(409, { error: job.state });
        s.writeHead(200, { ...CORS, 'content-type': 'video/mp4', 'content-length': String(statSync(f).size) });
        const r = createReadStream(f);
        r.pipe(s);
        s.on('finish', () => setTimeout(() => { if (Date.now() - last > 15000) end('the part was fetched'); }, 20000));
        return undefined;
      }
      if (q.method === 'DELETE' && u.pathname === '/self') { send(202, { ending: true }); return end('asked by the page'); }
      return send(404, { error: 'route' });
    } catch (e) {
      return send(500, { error: String(e?.message || e).slice(0, 200) });
    }
  });
  await new Promise((ok) => server.listen(port, '0.0.0.0', ok));
  log(`ready on :${port} (greenlight-motion ${VERSION})`);
  startDisplay().catch((e) => log(`display: ${e.message}`));
  await new Promise(() => {});
}
