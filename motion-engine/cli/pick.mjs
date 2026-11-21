// `greenlight-motion pick <dir> [--title t] [--port 4811] [--open]`: a pick page for generated pictures, served on 127.0.0.1
// (nothing leaves this computer). The candidates of each frame in a row; a click picks the TAKE (the picture to use), the
// next clicks EXTRAS (may be used too, or instead), a note per frame; Save for agent writes <dir>/PICKS.json + PICKS.md.
// It IS the board's pick card (GreenLight Dash's photo card: frontend/public/photo-picker/picker.js + picker.css, the same
// grammar: take red, extras yellow, T / E / X in the large view, Swipe), fed its data (window.PP_DATA) by this file; its
// two card routes (`/api/moodboards/local/review-cards/local` and `…/save`) are answered here instead of by the app.
// The page's code ships in the package's dist/photo-picker/ (scripts/prepare.mjs copies it); in the source repository
// it is read from frontend/public/photo-picker/.
//
// What is picked from: <dir>/pick.json — { "title": "…", "frames": [{ "frame": "S01", "title": "the cold open",
// "files": ["S01/a.png", …] }, …] } or { "S01": ["S01/a.png", …], … } (paths relative to <dir>) — else every subfolder
// <dir>/<frame>/ with pictures (.png .jpg .jpeg .webp .gif .avif), frames and pictures in name order.
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { send, sendFile, readBody, inside, listen, openBrowser } from './localServe.mjs';

const PICTURE = /\.(png|jpe?g|webp|gif|avif)$/i;
const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
const CARD = '/api/moodboards/local/review-cards/local';

// width / height from a picture's header (PNG, JPEG, WebP, GIF), or null
function imageSize(buf) {
  try {
    if (buf.readUInt32BE(0) === 0x89504e47) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    if (buf.toString('ascii', 0, 3) === 'GIF') return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
    if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      const kind = buf.toString('ascii', 12, 16);
      if (kind === 'VP8X') return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
      if (kind === 'VP8L') { const b = buf.readUInt32LE(21); return { w: 1 + (b & 0x3fff), h: 1 + ((b >> 14) & 0x3fff) }; }
      if (kind === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
    }
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      for (let i = 2; i + 9 < buf.length;) {
        if (buf[i] !== 0xff) { i += 1; continue; }
        const m = buf[i + 1];
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
        i += 2 + buf.readUInt16BE(i + 2);
      }
    }
  } catch { /* not a picture we read */ }
  return null;
}

// the frames and their candidate files (relative to dir, '/'-separated)
function framesOf(dir, fail) {
  const file = path.join(dir, 'pick.json');
  if (existsSync(file)) {
    let j;
    try { j = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { return fail(`${file} is not valid JSON: ${e.message}`); }
    const rows = Array.isArray(j.frames) ? j.frames : Object.entries(j).filter(([k, v]) => k !== 'title' && Array.isArray(v)).map(([frame, files]) => ({ frame, files }));
    const frames = rows.map((r, i) => {
      const files = (r.files || r.photos || r.candidates || []).map((f) => String(typeof f === 'string' ? f : f?.path || '').replace(/\\/g, '/').replace(/^\.\//, ''));
      for (const f of files) if (!inside(dir, f) || !existsSync(path.join(dir, f))) fail(`pick.json: frame "${r.frame || i + 1}" names ${f}, which is not a file in ${dir}`);
      return { frame: String(r.frame || r.shot || `F${i + 1}`).replace(/=/g, '-'), title: r.title ? String(r.title) : '', files };
    }).filter((r) => r.files.length);
    return { title: typeof j.title === 'string' ? j.title : null, frames };
  }
  const frames = readdirSync(dir).filter((d) => !d.startsWith('.') && statSync(path.join(dir, d)).isDirectory()).sort(natural)
    .map((d) => ({ frame: d.replace(/=/g, '-'), title: '', files: readdirSync(path.join(dir, d)).filter((f) => PICTURE.test(f) && !f.startsWith('.')).sort(natural).map((f) => `${d}/${f}`) }))
    .filter((r) => r.files.length);
  return { title: null, frames };
}

const pageHtml = (data) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${String(data.title).replace(/[<>&"]/g, '')} · pick</title>
<style>html,body{margin:0;background:#111;color:#edf1ee;font-family:system-ui,sans-serif}#loading{padding:40px}</style>
<link rel="stylesheet" href="/photo-picker/picker.css">
</head>
<body>
<!-- greenlight-motion pick (motion-engine/cli/pick.mjs): the board's pick card, its pictures from this folder. -->
<p id="loading">Loading…</p>
<script>window.PP_DATA = ${JSON.stringify(data).replace(/<\//g, '<\\/')};</script>
<script src="/photo-picker/picker.js"></script>
<script>(function () { var l = document.getElementById('loading'); if (l && window.PP) l.remove(); else if (l) l.textContent = 'The pick page did not load.'; })();</script>
</body></html>
`;

export async function pick({ dir: d, flags, ctx }) {
  const { fail, PKG } = ctx;
  const dir = path.resolve(d);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) fail(`no folder ${d}`);
  const code = [path.join(PKG, 'dist', 'photo-picker'), path.resolve(PKG, '..', 'frontend', 'public', 'photo-picker')].find((p) => existsSync(path.join(p, 'picker.js')));
  if (!code) fail('the pick page is missing from this package (dist/photo-picker/)', 'reinstall greenlight-motion');
  const found = framesOf(dir, fail);
  if (!found.frames.length) fail(`nothing to pick in ${dir}`, 'put each frame\'s pictures in a subfolder (<dir>/<frame>/*.png|jpg|webp), or list them in <dir>/pick.json');
  const title = typeof flags.title === 'string' ? flags.title : found.title || path.basename(dir);
  // ids: a picture's name without its extension (unique in its frame)
  const fileOf = {};   // `${frame}\n${id}` → file
  const shots = found.frames.map((f, gi) => {
    const used = new Set();
    return { g: `A-${gi}`, shot: f.frame, title: f.title || f.frame, tags: [], photos: f.files.map((rel) => {
      let id = path.basename(rel).replace(/\.[^.]+$/, '') || 'picture';
      if (used.has(id)) id = path.basename(rel);
      for (let i = 2; used.has(id); i += 1) id = `${path.basename(rel).replace(/\.[^.]+$/, '')}-${i}`;
      used.add(id);
      fileOf[`${f.frame}\n${id}`] = rel;
      const url = `files/${rel.split('/').map(encodeURIComponent).join('/')}`;
      return { id, full: url, thumb: url };
    }) };
  });
  const first = imageSize(readFileSync(path.join(dir, found.frames[0].files[0])));
  const total = found.frames.reduce((n, f) => n + f.files.length, 0);
  const key = 'glmp-' + createHash('sha1').update(`${dir}\n${found.frames.map((f) => `${f.frame}:${f.files.join(',')}`).join('\n')}`).digest('hex').slice(0, 12);
  const data = { v: 1, kind: 'photos', card: 'local', board: 'local', key, title, base: '', ratio: first && first.h ? first.w / first.h : 1,
    sets: [{ k: 'A', title, sub: `${found.frames.length} frame${found.frames.length === 1 ? '' : 's'} · ${total} pictures`, shots }] };
  const html = pageHtml(data);
  const jsonFile = path.join(dir, 'PICKS.json');
  const mdFile = path.join(dir, 'PICKS.md');

  const server = http.createServer(async (req, res) => {
    try {
      const p = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (p === `${CARD}/save` && req.method === 'POST') {
        const body = JSON.parse((await readBody(req, 16 * 1048576)).toString('utf8'));
        const r = writePicks({ dir, title, frames: found.frames, fileOf, picks: body?.payload?.picks?.A || {}, raw: body?.payload?.picks || {} });
        writeFileSync(jsonFile, JSON.stringify(r.json, null, 1));
        writeFileSync(mdFile, r.md);
        console.log(`${new Date().toLocaleTimeString()}  saved: ${r.summary} → ${mdFile}`);
        return send(res, 200, JSON.stringify({ saves: 1, woke: false }));
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'not allowed', 'text/plain');
      if (p === '/' || p === '/index.html') return send(res, 200, html, 'text/html; charset=utf-8');
      // the picks saved earlier come back to a browser that has none (the card's fromCard)
      if (p === CARD) {
        let j = null; try { j = JSON.parse(readFileSync(jsonFile, 'utf8')); } catch { /* not saved yet */ }
        return send(res, 200, JSON.stringify(j ? { payload: { kind: 'photos', picks: j.picks || {} }, saved_at: Date.parse(j.saved) / 1000 } : {}));
      }
      if (p === '/photo-picker/picker.js' || p === '/photo-picker/picker.css') return sendFile(req, res, path.join(code, path.basename(p)));
      if (p.startsWith('/files/') && PICTURE.test(p)) return sendFile(req, res, inside(dir, p.slice('/files/'.length)));
      if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }
      return send(res, 404, 'not found', 'text/plain');
    } catch (e) {
      return send(res, 500, JSON.stringify({ detail: String(e?.message || e) }));
    }
  });
  const port = flags.port !== undefined ? Number(flags.port) : 4811;
  const url = await listen(server, port);
  console.log(`pick: ${url}\n  ${found.frames.length} frame(s), ${total} pictures from ${dir}.\n  Open it in Chrome or Edge. Save for agent writes ${mdFile} and PICKS.json.\n  Ctrl+C to stop.`);
  if (flags.open) openBrowser(url);
  await new Promise(() => {});   // serves until stopped
}

// picks: { [frame]: { picks: [ids: the take first, then the extras], note? } } (the card's payload for its one set)
function writePicks({ dir, title, frames, fileOf, picks, raw }) {
  const saved = new Date();
  const rows = frames.map((f) => {
    const o = picks[f.frame] || {};
    const files = (o.picks || []).map((id) => fileOf[`${f.frame}\n${id}`]).filter(Boolean);
    return { frame: f.frame, title: f.title || null, take: files[0] || null, extras: files.slice(1), note: String(o.note || '').trim(), candidates: f.files.length };
  });
  const json = { kind: 'picks', title, saved: saved.toISOString(), dir, frames: rows, picks: raw };
  const picked = rows.filter((r) => r.take);
  const q = (s) => `"${s.replace(/\s+/g, ' ')}"`;
  const L = [`# Picks — ${title}`, '',
    `Saved ${json.saved.replace('T', ' ').slice(0, 16)} UTC from ${dir}. ${picked.length} of ${rows.length} frames picked.`,
    'One line per frame: the TAKE (the picture to use), then the EXTRAS in order (use them too, or instead when the take fails). Paths are relative to this folder.', ''];
  for (const r of rows) {
    L.push(r.take ? `- ${r.frame}${r.title && r.title !== r.frame ? ` (${r.title})` : ''} = take ${r.take}${r.extras.length ? ` · extras ${r.extras.join(', ')}` : ''}`
      : `- ${r.frame}${r.title && r.title !== r.frame ? ` (${r.title})` : ''} = not picked: yours to choose`);
    if (r.note) L.push(`  note: ${q(r.note)}`);
  }
  L.push('', '## For the agent', '',
    '- A picked frame: build on its take; an extra may be used too, or instead when the take fails (say so). Never a picture the user did not pick for that frame, and do not generate that frame again unless its note asks.',
    '- A frame not picked is yours to choose: the other frames\' picks show the taste.',
    '- Tell the user in one line what you go on with. PICKS.json is the same as data.');
  return { json, md: L.join('\n') + '\n', summary: `${picked.length} of ${rows.length} frames picked` };
}
