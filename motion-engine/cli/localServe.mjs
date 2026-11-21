// What the CLI's local pages share (cli/compare.mjs: `review a b c`, cli/pick.mjs: `pick`): a file sent with byte ranges
// (a <video> seeks an MP4 by Range requests: without 206 answers it cannot jump), a request's body, a port on 127.0.0.1
// only (nothing leaves this computer), and the user's browser opened on --open.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';

export const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.avif': 'image/avif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/mp4',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.aac': 'audio/aac',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.hdr': 'application/octet-stream', '.exr': 'application/octet-stream',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.wasm': 'application/wasm',
};

export function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

// FILE to the response, a `Range: bytes=a-b` request answered with 206 and that part only
export function sendFile(req, res, file) {
  if (!file || !existsSync(file) || statSync(file).isDirectory()) return send(res, 404, 'not found', 'text/plain');
  const size = statSync(file).size;
  const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const head = { 'content-type': type, 'cache-control': 'no-store', 'accept-ranges': 'bytes' };
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
  if (m && (m[1] || m[2])) {
    let a = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    let b = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (!(a <= b) || a >= size) { res.writeHead(416, { 'content-range': `bytes */${size}` }); res.end(); return undefined; }
    res.writeHead(206, { ...head, 'content-range': `bytes ${a}-${b}/${size}`, 'content-length': b - a + 1 });
    if (req.method === 'HEAD') { res.end(); return undefined; }
    createReadStream(file, { start: a, end: b }).pipe(res);
    return undefined;
  }
  res.writeHead(200, { ...head, 'content-length': size });
  if (req.method === 'HEAD') { res.end(); return undefined; }
  createReadStream(file).pipe(res);
  return undefined;
}

export const readBody = (req, limit = 512 * 1048576) => new Promise((ok, no) => {
  const chunks = [];
  let n = 0;
  req.on('data', (c) => { n += c.length; if (n > limit) { no(new Error('the request is too large')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => ok(Buffer.concat(chunks)));
  req.on('error', no);
});

// a path under ROOT for a request path (null when it would leave ROOT)
export function inside(root, rel) {
  const file = path.resolve(root, String(rel || '').replace(/^\/+/, ''));
  return file === root || file.startsWith(root + path.sep) ? file : null;
}

export async function listen(server, port) {
  await new Promise((ok, no) => { server.once('error', no); server.listen(port, '127.0.0.1', ok); });
  return `http://127.0.0.1:${server.address().port}/`;
}

export function openBrowser(url) {
  const opener = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  spawn(opener[0], opener[1], { stdio: 'ignore', detached: true }).unref();
}
