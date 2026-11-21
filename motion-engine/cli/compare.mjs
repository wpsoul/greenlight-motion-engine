// `greenlight-motion review <dir> [<dir2> …] [--titles "A,B,C"] [--subs "…,…"] [--title t] [--out <dir>] [--live] [--port 4810] [--open]`:
// the review page — the review card GreenLight Dash puts on a board (the engine's studio, GreenLightMotion.mountStudio),
// served on 127.0.0.1 (nothing leaves this computer). Several films: every film a source A, B, C … (Notes and Highlight
// across them, the Sources list, a filmstrip per film) plus a PICK: the film to go on with, or a mix. One film: today's
// single-film studio (Edit · Notes · Highlight on its live project; Notes · Highlight over its render), no pick, no A/B.
// Save for agent writes it all into <out>/review/ (the first folder's unless --out): notes.json (kind "review", the same
// format for 1 and N films: `films` lists them), NOTES.md and a picture of every noted moment, each with its film's key.
//
// What a source plays: the folder's RENDER (its newest top-level .mp4, when it is newer than project.json; `render`
// writes one) as a video over an empty film, the way the board's card plays renders — light, smooth and exactly the
// frames the user will get; else the LIVE PROJECT (the engine draws it). The studio holds one engine page, so only the
// source on show is live: picking a live source mounts its project (its own files, padded to the shared timeline), a
// render source switches in place. --live plays every folder's project even when it has a render.
// The page's host is cli/compare-host.js (+ .css), adapted from the board card's frontend/public/review-card/card.js.
// Each film's filmstrip and poster are drawn by the engine once, headless, and kept in <dir>/.review/ (made again when
// the project, its files or the engine change).
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { send, sendFile, readBody, inside, listen, openBrowser } from './localServe.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PALETTE = ['#ffb347', '#33efab', '#ff7a45', '#7cc4ff', '#f472b6', '#facc15', '#a3e635', '#c4b5fd', '#fb7185'];   // the board card's
const KEYS = 'ABCDEFGHI';
const PREP = 3;   // the cache's version: bump when what prepFilm makes changes
const PAD = 'glmc-pad';   // the page pads a shorter live film to the shared length with an invisible layer of this id

const list = (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()) : []);
const fix2 = (t) => (Math.round(t * 100) / 100).toFixed(2);

// the folder's render: its newest top-level .mp4, and whether it is newer than the project (so it shows the project as it is)
function renderOf(dir) {
  const pj = statSync(path.join(dir, 'project.json')).mtimeMs;
  const mp4 = readdirSync(dir).filter((f) => /\.mp4$/i.test(f) && statSync(path.join(dir, f)).isFile())
    .map((f) => ({ file: path.join(dir, f), at: statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.at - a.at)[0];
  return mp4 ? { file: mp4.file, fresh: mp4.at >= pj } : null;
}

// what the engine draws for a film, once (its length, fps, top-level layers, a filmstrip and a poster), cached by the bytes
// that make it: project.json, every file under assets/ (name, size, time) and the engine bundle
function signature(dir, ctx) {
  const h = createHash('sha256').update(String(PREP)).update(readFileSync(path.join(dir, 'project.json')));
  const e = statSync(ctx.ENGINE); h.update(`${e.size}:${e.mtimeMs}`);
  for (const rel of ctx.filesUnder(path.join(dir, 'assets')).sort()) { const s = statSync(path.join(dir, 'assets', rel)); h.update(`${rel}:${s.size}:${s.mtimeMs}`); }
  return h.digest('hex');
}

// in the film's own page (headless): its numbers and pictures. A thumb every `step` frames, side by side (the board card's
// filmstrip sprite: { n, step, tw, th }), and a poster twice that size.
const PAGE_PREP = async ({ most, tw0 }) => {
  const g = window.GreenLightMotion.page;
  const d = g.duration, fps = g.state().fps || 30, frames = Math.max(1, Math.round(d * fps));
  const size = window.GL_PROJECT?.videoSize || { w: 1920, h: 1080 };
  const portrait = size.h > size.w, tw = portrait ? 72 : tw0, th = Math.max(1, Math.round(tw * size.h / size.w));
  const want = Math.max(12, Math.min(most, Math.round(d * 3)));
  const step = Math.max(1, Math.ceil(frames / want)), n = Math.max(1, Math.ceil(frames / step));
  const load = (src) => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error('a frame did not load')); i.src = src; });
  const strip = document.createElement('canvas'); strip.width = tw * n; strip.height = th;
  const sg = strip.getContext('2d');
  for (let i = 0; i < n; i += 1) {
    const f = Math.min(frames - 1, i * step + Math.floor(step / 2));
    sg.drawImage(await load(await g.renderFrame(f / fps)), i * tw, 0, tw, th);
  }
  const poster = document.createElement('canvas'); poster.width = tw * 2; poster.height = th * 2;
  poster.getContext('2d').drawImage(await load(await g.renderFrame(Math.min(2.4, d / 3))), 0, 0, poster.width, poster.height);
  // top-level layers (a scene script's scenes are sequence layers on one row) and the frames a highlight snaps to: where a
  // layer starts or ends and where its keyframes are (the studio's own snap points, per film)
  const items = new Map();
  for (const ch of window.GL_PROJECT?.channels || []) for (const it of ch.items || []) items.set(it.id, it);
  const layers = g.layers().map((l) => ({ id: l.id, type: l.type, name: l.name, start: l.start, end: l.end }));
  const cuts = new Set();
  for (const l of layers.filter((x) => x.type !== 'audio')) {   // sound cues are not on the picture
    cuts.add(Math.round(l.start * fps)); cuts.add(Math.round(l.end * fps));
    for (const track of Object.values(items.get(l.id)?.propertyKeyframes || {})) for (const k of track || []) cuts.add(Math.round((l.start + (k.position / 100) * (l.end - l.start)) * fps));
  }
  return { duration: d, fps, frames, size, layers, cuts: [...cuts].filter((f) => f > 0 && f < frames).sort((a, b) => a - b),
    strip: strip.toDataURL('image/jpeg', 0.8), poster: poster.toDataURL('image/jpeg', 0.85), n, step, tw, th };
};

async function prepFilms(films, ctx, log) {
  const todo = films.filter((f) => {
    try {
      const c = JSON.parse(readFileSync(path.join(f.dir, '.review', 'film.json'), 'utf8'));
      if (c.sig === f.sig && existsSync(path.join(f.dir, '.review', 'strip.jpg'))) { f.prep = c; return false; }
    } catch { /* not made yet */ }
    return true;
  });
  if (!todo.length) return;
  const browser = await ctx.launch();
  try {
    for (const f of todo) {
      const t0 = Date.now();
      const served = f.world ? await ctx.serveFolder(f.dir) : null;
      const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
      try {
        await page.goto(served ? served.url : 'file://' + path.join(f.dir, 'index.html'));
        await page.waitForFunction(() => window.GreenLightMotion?.page?.ready, null, { timeout: 120000 });
        await page.evaluate(() => window.GreenLightMotion.page.renderFrame(0));   // files arrive in waves (a model, then its HDR)
        await page.waitForTimeout(400);
        const r = await page.evaluate(PAGE_PREP, { most: 48, tw0: 128 });
        const out = path.join(f.dir, '.review');
        mkdirSync(out, { recursive: true });
        writeFileSync(path.join(out, 'strip.jpg'), Buffer.from(r.strip.split(',')[1], 'base64'));
        writeFileSync(path.join(out, 'poster.jpg'), Buffer.from(r.poster.split(',')[1], 'base64'));
        const { strip, poster, ...rest } = r;
        f.prep = { v: PREP, sig: f.sig, ...rest };
        writeFileSync(path.join(out, 'film.json'), JSON.stringify(f.prep));
        log(`  ${f.key} ${f.name}: ${r.duration.toFixed(2)} s, filmstrip of ${r.n} frames (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
      } finally {
        await page.close();
        served?.close();
      }
    }
  } finally {
    await browser.close();
  }
}

// a film's parts: a scene script's scenes (its sequence layers, in order, when there are two or more), [name, seconds, sub]
const partsOf = (layers) => {
  const seq = (layers || []).filter((l) => l.type === 'sequence').sort((a, b) => a.start - b.start);
  return seq.length >= 2 ? seq.map((l) => [String(l.name || l.id).slice(0, 24), +l.start.toFixed(3), `${fix2(l.start)}–${fix2(l.end)} s`]) : [];
};

const pageHtml = (data) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${String(data.title).replace(/[<>&"]/g, '')} · review</title>
<style>html,body{margin:0;background:#111;color:#edf1ee;font-family:system-ui,sans-serif}#loading{padding:40px}</style>
<link rel="stylesheet" href="/__glm/compare/host.css">
</head>
<body class="rv-mode-${data.start}${data.single ? ' glmc-single' : ''}${data.modes.includes('edit') ? '' : ' glmc-noedit'}" style="${data.size.h > data.size.w ? '--rvc-po-w:32px;--rvc-po-h:57px;--rvc-po-ar:3/4' : '--rvc-po-w:64px;--rvc-po-h:36px;--rvc-po-ar:16/9'}">
<!-- greenlight-motion review: the review page for one film or several (motion-engine/cli/compare.mjs). The engine brings
     the studio; /__glm/compare/host.js is this page's host (its sources, the pick, Save for agent → review/). -->
<div id="app"><p id="loading">Loading the review…</p></div>
<script>
window.GLMC_FETCH = window.fetch.bind(window);
window.GLMC_DATA = ${JSON.stringify(data).replace(/<\//g, '<\\/').replace(/<!--/g, '<\\u0021--')};
${data.world ? 'window.GL_WORLD_BASE = "world3d/";\n' : ''}</script>
<script src="/greenlight-motion.js"></script>
<script src="/__glm/compare/host.js"></script>
</body></html>
`;

export async function compare({ dirs, flags, ctx }) {
  const { fail } = ctx;
  if (dirs.length > KEYS.length) fail(`at most ${KEYS.length} films in one review page`, 'review the others in a second page');
  const seen = new Set();
  const titles = list(flags.titles), subs = list(flags.subs);
  const films = dirs.map((d, i) => {
    const dir = path.resolve(d);
    if (seen.has(dir)) fail(`${d} is named twice`);
    seen.add(dir);
    const { project } = ctx.build(dir, { quiet: true });   // the folder's page files, its sounds and 3D files, as `review` does
    const name = path.basename(dir);
    const r = flags.live ? null : renderOf(dir);
    const video = r?.fresh ? r.file : null;
    if (r && !r.fresh && !flags.live) console.log(`${KEYS[i]} ${name}: ${path.basename(r.file)} is older than project.json, so the page plays the live project (render again to review the render)`);
    return { key: KEYS[i], dir, name, title: dirs.length === 1 ? titles[i] || name : `${KEYS[i]} · ${titles[i] || name}`, sub: subs[i] || '', colour: PALETTE[i % PALETTE.length],
      video, world: ctx.hasWorld(project), project, sig: signature(dir, ctx) };
  });
  const out = path.resolve(String(typeof flags.out === 'string' ? flags.out : films[0].dir));
  const reviewDir = path.join(out, 'review');

  const single = films.length === 1;
  console.log(`preparing ${single ? 'the film' : `${films.length} films`} (filmstrips are made once per version and kept in each folder's .review/)`);
  await prepFilms(films, ctx, (m) => console.log(m));

  // one shared timeline: the longest film, at the first film's fps and size (frame n is the same moment in every film)
  const fps = films[0].prep.fps || 30;
  const frames = Math.max(...films.map((f) => Math.round(f.prep.duration * fps)));
  const size = films[0].project.videoSize || films[0].prep.size || { w: 1920, h: 1080 };
  for (const f of films.slice(1)) {
    const s = f.project.videoSize || f.prep.size;
    if (s && (s.w !== size.w || s.h !== size.h)) console.log(`note: ${f.key} is ${s.w}×${s.h}, ${films[0].key} ${size.w}×${size.h}: notes are drawn on a ${size.w}×${size.h} frame`);
    if (f.prep.fps !== fps) console.log(`note: ${f.key} is ${f.prep.fps} fps; the shared timeline counts ${fps} fps`);
  }
  // the page's storage key: these folders as they are now, so a new version of any film opens a fresh review
  const storeKey = 'glmc-' + createHash('sha1').update(films.map((f) => `${f.dir}\n${f.sig}\n${f.video ? statSync(f.video).mtimeMs : ''}`).join('\n')).digest('hex').slice(0, 12);
  const title = typeof flags.title === 'string' ? flags.title : (films[0].project.template?.title || films[0].project.name || films[0].name);
  const data = {
    v: 1, title, fps, frames, duration: frames / fps, size, storeKey, out: reviewDir, world: films.some((f) => f.world), single,
    // one live film keeps the single-film studio's Edit (its layers, options, Render); a render or several films: Notes · Highlight
    modes: single && !films[0].video ? ['edit', 'notes', 'highlight'] : ['notes', 'highlight'],
    start: 'highlight',   // every review opens in Highlight, as the board's review card (the owner, 2026-11-21); Edit is one click away
    films: films.map((f) => {
      const u = `/__glm/films/${f.key}`;
      const assets = {};
      for (const rel of ctx.filesUnder(path.join(f.dir, 'assets'))) {
        for (const k of ctx.assetKeys(rel)) assets[k] = `${u}/assets/${rel.split('/').map(encodeURIComponent).join('/')}`;
      }
      const plays = f.video ? 'video' : 'project';
      return { key: f.key, title: f.title, about: f.sub || '', sub: f.sub || `${f.name} · ${plays === 'video' ? `render ${path.basename(f.video)}` : 'live project'} · ${fix2(f.prep.duration)} s`,
        colour: f.colour, name: f.name, plays, video: f.video ? `${u}/video.mp4` : null, project: `${u}/project.json`, assets, world: f.world,
        duration: f.prep.duration, parts: partsOf(f.prep.layers), cuts: f.prep.cuts,
        strip: { src: `${u}/strip.jpg`, n: f.prep.n, step: f.prep.step, tw: f.prep.tw, th: f.prep.th }, poster: `${u}/poster.jpg` };
    }),
  };
  const byKey = Object.fromEntries(films.map((f) => [f.key, f]));
  const html = pageHtml(data);
  const worldDir = films.find((f) => f.world) ? path.join(films.find((f) => f.world).dir, 'world3d') : null;

  const server = http.createServer(async (req, res) => {
    try {
      const p = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (p === '/__glm/compare/save' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString('utf8'));
        const r = writeReview(reviewDir, body, data, byKey);
        console.log(`${new Date().toLocaleTimeString()}  saved: ${r.summary} → ${path.join(reviewDir, 'NOTES.md')}`);
        return send(res, 200, JSON.stringify({ ok: true, where: reviewDir, pictures: r.pictures }));
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'not allowed', 'text/plain');
      if (p === '/' || p === '/index.html') return send(res, 200, html, 'text/html; charset=utf-8');
      if (p === '/greenlight-motion.js') return sendFile(req, res, ctx.ENGINE);
      if (p === '/__glm/compare/host.js') return sendFile(req, res, path.join(HERE, 'compare-host.js'));
      if (p === '/__glm/compare/host.css') return sendFile(req, res, path.join(HERE, 'compare-host.css'));
      if (p === '/__glm/compare') return send(res, 200, existsSync(path.join(reviewDir, 'notes.json')) ? readFileSync(path.join(reviewDir, 'notes.json')) : '{}');
      // the engine page's own notes ask whether a single-film review serves them (useReview.js): not here — they stay off
      if (p === '/__glm/review') return send(res, 200, '{}');
      if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }
      if (worldDir && p.startsWith('/world3d/')) return sendFile(req, res, inside(worldDir, p.slice('/world3d/'.length)));
      const m = /^\/__glm\/films\/([A-I])\/(.+)$/.exec(p);
      const f = m && byKey[m[1]];
      if (f) {
        const what = m[2];
        if (what === 'project.json') return send(res, 200, readFileSync(path.join(f.dir, 'project.json')));
        if (what === 'video.mp4' && f.video) return sendFile(req, res, f.video);
        if (what === 'strip.jpg' || what === 'poster.jpg') return sendFile(req, res, path.join(f.dir, '.review', what));
        if (what.startsWith('assets/')) return sendFile(req, res, inside(path.join(f.dir, 'assets'), what.slice('assets/'.length)));
      }
      return send(res, 404, 'not found', 'text/plain');
    } catch (e) {
      return send(res, 500, JSON.stringify({ error: String(e?.message || e) }));
    }
  });
  const port = flags.port !== undefined ? Number(flags.port) : 4810;
  const url = await listen(server, port);
  console.log(`review: ${url}\n  ${single ? `${films[0].name}: ${films[0].video ? `its render ${path.basename(films[0].video)}` : 'the live project'}` : `${films.length} films in one page: ${films.map((f) => `${f.key} ${f.name} (${f.video ? 'its render' : 'live project'})`).join(', ')}`}.`
    + `\n  Open it in Chrome or Edge. Save for agent writes ${reviewDir}/ (NOTES.md, notes.json, a picture of every noted moment).\n  Ctrl+C to stop.`);
  if (flags.open) openBrowser(url);
  await new Promise(() => {});   // serves until stopped
}

// ── Save for agent → <out>/review/ ──
// body: { payload: the studio's own payload ({ notes, highlights, pick }), notes: [{ n, id, text, thread, shots: [{ src, kind,
// t, end, marks, layers: [ids], image: data URL }] }] }
function writeReview(dir, body, data, byKey) {
  mkdirSync(dir, { recursive: true });
  const fps = data.fps;
  const films = data.films;
  const film = (k) => films.find((f) => f.key === k) || films[0];
  const partAt = (k, t) => { let p = null; for (const x of film(k).parts || []) if (x[1] <= t + 1e-6) p = x[0]; return p; };
  const fr = (t) => Math.round(t * fps);
  let before = [];
  try { const old = JSON.parse(readFileSync(path.join(dir, 'notes.json'), 'utf8')); if (Array.isArray(old?.pictures)) before = old.pictures.filter((x) => typeof x === 'string'); } catch { /* the first save, or an older file */ }
  const pictures = [];
  const names = new Set();
  const notes = (Array.isArray(body.notes) ? body.notes : []).map((n) => {
    const shots = (n.shots || []).map((s) => {
      const k = byKey[s.src] ? s.src : films[0].key;
      const t = Number(s.t) || 0;
      const end = s.end == null ? null : Number(s.end);
      let picture = null;
      const m = /^data:image\/(png|jpeg|webp);base64,(.+)$/s.exec(String(s.image || ''));
      if (m) {
        const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
        const base = end == null ? `${k}-at-${fix2(t)}s-n${n.n}` : `${k}-${fix2(t)}-${fix2(end)}s-n${n.n}`;
        let name = `${base}.${ext}`;
        for (let i = 2; names.has(name); i += 1) name = `${base}-${i}.${ext}`;
        names.add(name);
        writeFileSync(path.join(dir, name), Buffer.from(m[2], 'base64'));
        pictures.push(name);
        picture = name;
      }
      const layers = (s.layers || []).map((l) => (typeof l === 'string' ? l : l?.id)).filter((id) => id && id !== PAD);
      return { film: k, kind: end == null ? 'frame' : 'range', t: +t.toFixed(3), frame: fr(t), end: end == null ? null : +end.toFixed(3),
        endFrame: end == null ? null : fr(end), marks: Number(s.marks) || 0, layers, part: partAt(k, t), picture };
    });
    return { n: n.n, id: n.id, film: shots[0]?.film || films[0].key, t: shots[0]?.t ?? 0, text: String(n.text || ''), shots,
      thread: (n.thread || []).map((c) => ({ by: c.by, text: c.text, at: c.at })) };
  }).sort((a, b) => a.n - b.n);
  const highlights = (body.payload?.highlights || []).map((h, i) => ({ n: i + 1, film: byKey[h.source] ? h.source : films[0].key, a: h.a, b: h.b,
    from: +(h.a / fps).toFixed(3), to: +((h.b + 1) / fps).toFixed(3), seconds: +((h.b - h.a + 1) / fps).toFixed(3),
    note: String(h.note || ''), must: !!h.must, part: partAt(byKey[h.source] ? h.source : films[0].key, h.a / fps) }));
  const pk = body.payload?.pick || null;
  const pick = pk && (pk.film || pk.mix || pk.note) ? { film: byKey[pk.film] ? pk.film : null, title: byKey[pk.film] ? film(pk.film).title : null, mix: !pk.film && !!pk.mix, note: String(pk.note || '') } : null;
  // pictures of an earlier save that this one no longer has (only the ones this page wrote)
  for (const old of before) if (!pictures.includes(old) && /^[A-I]-[\w.-]+\.(png|jpg|webp)$/.test(old)) rmSync(path.join(dir, old), { force: true });
  const saved = new Date();
  const review = {
    kind: 'review', title: data.title, saved: saved.toISOString(), fps, frames: data.frames, duration: +data.duration.toFixed(3),
    films: films.map((f) => ({ key: f.key, title: f.title, about: f.about, dir: byKey[f.key].dir, plays: f.plays,
      video: f.plays === 'video' ? path.basename(byKey[f.key].video) : null, duration: +f.duration.toFixed(3), parts: f.parts })),
    pick, notes, highlights, pictures,
  };
  writeFileSync(path.join(dir, 'notes.json'), JSON.stringify(review, null, 1));
  writeFileSync(path.join(dir, 'NOTES.md'), notesMd(review));
  const summary = [`${notes.length} note${notes.length === 1 ? '' : 's'}`, `${highlights.length} highlight${highlights.length === 1 ? '' : 's'}`,
    ...(films.length > 1 ? [pick ? `pick ${pick.film || 'a mix'}` : 'no pick'] : [])].join(', ');
  return { summary, pictures };
}

function notesMd(r) {
  const fps = r.fps;
  const ft = (t) => `${fix2(t)} s (f${Math.round(t * fps)})`;
  const quote = (s) => `"${String(s).replace(/\s+/g, ' ').trim()}"`;
  const film = (k) => r.films.find((f) => f.key === k);
  if (r.films.length === 1) return notesMdOne(r, ft, quote);
  const L = [`# Review — ${r.title} (${r.films.length} films)`, '',
    `Saved ${r.saved.replace('T', ' ').slice(0, 16)} UTC. One shared timeline: ${fps} fps, ${fix2(r.duration)} s (${r.frames} frames); frame n is the same moment in every film. Highlights are in frames, inclusive.`, ''];
  if (r.pick?.film) L.push(`**Pick: ${r.pick.title}** — the film to go on with${r.pick.note ? `: ${quote(r.pick.note)}` : '.'}`);
  else if (r.pick?.mix) L.push(`**Pick: a mix** of the films${r.pick.note ? `: ${quote(r.pick.note)}` : ' (no note says how: ask)'}.`);
  else L.push(`**Pick: none** — the user picked no film${r.pick?.note ? `, but wrote: ${quote(r.pick.note)}` : ''}.`);
  L.push('', '| Film | Folder | Plays | Length |', '|---|---|---|---|');
  for (const f of r.films) L.push(`| ${f.title}${f.about ? ` — ${f.about}` : ''} | ${f.dir} | ${f.plays === 'video' ? `its render ${f.video}` : 'the live project'} | ${fix2(f.duration)} s |`);
  for (const f of r.films) {
    const notes = r.notes.filter((n) => n.film === f.key);
    const hls = r.highlights.filter((h) => h.film === f.key);
    L.push('', `## ${f.title}${r.pick?.film === f.key ? ' ← the pick' : ''}`, '');
    if (f.parts?.length) L.push(`Parts: ${f.parts.map((p) => `${p[0]} ${fix2(p[1])} s`).join(' · ')}`, '');
    L.push(notes.length ? `Notes (${notes.length}):` : 'Notes: none');
    for (const n of notes) {
      L.push(`- #${n.n} ${n.text ? quote(n.text) : '(drawings only)'}`);
      for (const s of n.shots) {
        const where = s.kind === 'range' ? `range ${fix2(s.t)}–${fix2(s.end)} s (f${s.frame}–f${s.endFrame})` : `frame ${ft(s.t)}`;
        L.push(`  - ${s.film !== f.key ? `${s.film} · ` : ''}${where}${s.part ? ` · part ${s.part}` : ''} · ${s.marks} mark${s.marks === 1 ? '' : 's'}`
          + `${s.layers.length ? ` · on screen: ${s.layers.map((id) => `\`${id}\``).join(', ')}` : ''}${s.picture ? ` · picture ${s.picture}` : ''}`);
      }
      for (const c of n.thread) L.push(`  - ${c.by === 'agent' ? 'agent' : 'user'}: ${quote(c.text)}`);
    }
    L.push('', hls.length ? `Highlights (${hls.length}; #n = its place in the new cut):` : 'Highlights: none');
    for (const h of hls) L.push(`- #${h.n}${h.must ? ' ★ must' : ''} · f${h.a}–f${h.b} · ${fix2(h.from)}–${fix2(h.to)} s (${fix2(h.seconds)} s)${h.part ? ` · part ${h.part}` : ''}${h.note ? ` · ${quote(h.note)}` : ''}`);
  }
  L.push('', '## The new cut', '');
  if (!r.highlights.length) L.push('No highlights: there is no new cut to build.');
  for (const h of r.highlights) L.push(`${h.n}. ${film(h.film)?.title || h.film} · f${h.a}–f${h.b} (${fix2(h.from)}–${fix2(h.to)} s)${h.must ? ' ★ must' : ''}${h.note ? ` · ${quote(h.note)}` : ''}`);
  L.push('', '## For the agent', '',
    '- Go on with the pick. A mix: combine the films as its note says. No pick: the notes and highlights say what the user liked.',
    '- A note: open its picture (beside this file: the frame or range it means, the user\'s drawing on it), change exactly that in that film\'s folder (`apply`), `build`.',
    '- Highlights: the parts the user liked, in the order of a new cut (frames inclusive, on the shared timeline). ★ must = keep it whatever else changes.',
    '- notes.json is this review as data (kind "review"): films (key → folder), pick, notes (each with its film, moment, layers on screen, picture), highlights.',
    '- Then show the new version(s) in a new review page: `greenlight-motion review <folders>`.');
  return L.join('\n') + '\n';
}

// one film: its notes and highlights, the same lines as for several, without the pick, the films table and the film keys
function notesMdOne(r, ft, quote) {
  const f = r.films[0];
  const L = [`# Review — ${r.title}`, '',
    `Saved ${r.saved.replace('T', ' ').slice(0, 16)} UTC. ${f.dir} · ${f.plays === 'video' ? `its render ${f.video}` : 'the live project'} · ${r.fps} fps, ${fix2(f.duration)} s. Highlights are in frames, inclusive.`, ''];
  if (f.parts?.length) L.push(`Parts: ${f.parts.map((p) => `${p[0]} ${fix2(p[1])} s`).join(' · ')}`, '');
  L.push(r.notes.length ? `## Notes (${r.notes.length})` : '## Notes: none', '');
  for (const n of r.notes) {
    L.push(`- #${n.n} ${n.text ? quote(n.text) : '(drawings only)'}`);
    for (const s of n.shots) {
      const where = s.kind === 'range' ? `range ${fix2(s.t)}–${fix2(s.end)} s (f${s.frame}–f${s.endFrame})` : `frame ${ft(s.t)}`;
      L.push(`  - ${where}${s.part ? ` · part ${s.part}` : ''} · ${s.marks} mark${s.marks === 1 ? '' : 's'}`
        + `${s.layers.length ? ` · on screen: ${s.layers.map((id) => `\`${id}\``).join(', ')}` : ''}${s.picture ? ` · picture ${s.picture}` : ''}`);
    }
    for (const c of n.thread) L.push(`  - ${c.by === 'agent' ? 'agent' : 'user'}: ${quote(c.text)}`);
  }
  L.push('', r.highlights.length ? `## Highlights (${r.highlights.length}, in the order of a new cut)` : '## Highlights: none', '');
  for (const h of r.highlights) L.push(`- #${h.n}${h.must ? ' ★ must' : ''} · f${h.a}–f${h.b} · ${fix2(h.from)}–${fix2(h.to)} s (${fix2(h.seconds)} s)${h.part ? ` · part ${h.part}` : ''}${h.note ? ` · ${quote(h.note)}` : ''}`);
  L.push('', '## For the agent', '',
    '- A note: open its picture (beside this file: the frame or range it means, the user\'s drawing on it), change exactly that in the film\'s folder (`apply`), `build`, and tell the user to reload the page.',
    '- Highlights: the parts the user liked, in the order of a new cut (frames inclusive). ★ must = keep it whatever else changes.',
    '- notes.json is this review as data (kind "review", the same format as a review of several films: `films` has one).');
  return L.join('\n') + '\n';
}
