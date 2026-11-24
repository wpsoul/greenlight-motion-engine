/*
 * GreenLight Motion Engine — an HTML layer's page as text the engine can load (the pure half of htmlPages.js).
 *
 * Outside GreenLight Dash a page is one of the project's files (`asset:ui/app.html`), and the engine loads it as a frame's
 * `srcdoc`. A srcdoc page has no folder of its own, so what the page takes from beside itself (`<img src="logo.png">`,
 * `<script src="chart.js">`, `url(bg.jpg)`) is written into it here as the URL the engine has for that file. Only files the
 * project really has are touched: every other address stays as the page wrote it.
 */

const OPENING_TAGS = [/<head\b[^>]*>/i, /<html\b[^>]*>/i, /<!doctype\b[^>]*>/i];

/** `tags` as the first thing in the page's <head> (else after <html> or the doctype), never before the doctype, which
 *  would drop the page into quirks mode — as the backend does it (html_clips.inject_head). */
export function injectHead(html, tags) {
  const text = String(html || '');
  for (const pattern of OPENING_TAGS) {
    const m = pattern.exec(text);
    if (m) return text.slice(0, m.index + m[0].length) + tags + text.slice(m.index + m[0].length);
  }
  return tags + text;
}

// An address that is not a file beside the page: it has a scheme (https:, data:, blob:, mailto:, javascript:), or starts
// at a host (//), at the root (/), or is only a fragment or a query.
const NOT_BESIDE = /^(?:[a-z][a-z0-9+.-]*:|\/|#|\?)/i;

/** The project reference of a file a page names, or null. A relative address is a file beside the page
 *  ('asset:ui/app.html' + 'img/a.png?v=2' → 'asset:ui/img/a.png'; null above the project's files); `asset:<name>` is the
 *  project's file of that name from any page, an inline one too (a page the model wrote has no folder). */
export function pageFileRef(pageRef, address) {
  const raw = String(address || '').trim();
  if (/^asset:[^?#]+/i.test(raw)) {
    const rel = raw.slice('asset:'.length).split(/[?#]/)[0];
    return rel.split('/').some((p) => !p || p === '.' || p === '..') ? null : `asset:${rel}`;
  }
  if (!raw || NOT_BESIDE.test(raw)) return null;
  const page = String(pageRef || '').split(/[?#]/)[0];
  const root = page.startsWith('asset:') ? 'asset:' : page.startsWith('/') ? '/' : null;
  if (root == null) return null;
  const parts = page.slice(root.length).split('/').slice(0, -1);   // the page's folder
  for (const seg of raw.split(/[?#]/)[0].split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { if (!parts.length) return null; parts.pop(); continue; }
    try { parts.push(decodeURIComponent(seg)); } catch { parts.push(seg); }
  }
  return parts.length ? root + parts.join('/') : null;
}

// A file handed over as bytes of no type (a data: URL the CLI wrote for an extension it does not know) under the type the
// browser asks of a stylesheet or a script: Chrome does not apply `data:application/octet-stream` as CSS.
const TYPES = { css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', svg: 'image/svg+xml', json: 'application/json', html: 'text/html', htm: 'text/html' };
export function typedUrl(url, ref) {
  const type = TYPES[String(ref).split('.').pop().toLowerCase()];
  return type && /^data:application\/octet-stream[;,]/.test(url) ? `data:${type}${url.slice('data:application/octet-stream'.length)}` : url;
}

const ATTR = /(\b(?:src|href|poster)\s*=\s*)(["'])([^"'<>]+)\2/gi;
const CSS_URL = /(url\(\s*)(["']?)([^"'()]+)\2(\s*\))/gi;

/** HTML with every relative address of a file the project has replaced by `urlOf(ref)` (→ a URL, or null: not a file of
 *  the project). Tag attributes (src, href, poster) and CSS url(). A stylesheet's own url() and a script's imports are
 *  not followed: they are in another file. */
export async function inlinePageFiles(html, pageRef, urlOf) {
  const text = String(html || '');
  const found = new Map();   // the address as written → its project reference
  for (const re of [ATTR, CSS_URL]) {
    for (const m of text.matchAll(re)) {
      if (found.has(m[3])) continue;
      const ref = pageFileRef(pageRef, m[3]);
      if (ref) found.set(m[3], ref);
    }
  }
  if (!found.size) return text;
  const urls = new Map();
  await Promise.all([...found].map(async ([address, ref]) => {
    const url = await urlOf(ref);
    if (typeof url === 'string' && url) urls.set(address, typedUrl(url, ref));
  }));
  if (!urls.size) return text;
  return text
    .replace(ATTR, (all, head, quote, address) => (urls.has(address) ? `${head}${quote}${urls.get(address)}${quote}` : all))
    .replace(CSS_URL, (all, head, quote, address, tail) => (urls.has(address) ? `${head}${quote}${urls.get(address)}${quote}${tail}` : all));
}

// ── A page the model writes (a scene script's `{ "type": "html", "html": "<!doctype html>…" }`) is kept IN the project as a
// data: URL, the way SVG art is: no file to carry, and it plays wherever the project goes. GreenLight Dash opens html clips
// from files, so a .glvideo writes such a page out as a file (pagesToFiles).
export const MAX_INLINE_PAGE = 512 * 1024;
export const isInlinePage = (url) => typeof url === 'string' && /^data:text\/html[;,]/i.test(url);

export function looksLikeHtml(text) {
  const head = String(text || '').trimStart().slice(0, 2000).toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html') || (head.includes('<body') && head.includes('</'));
}

/** Page markup → its data: URL (UTF-8, base64). */
export function htmlDataUrl(markup) {
  const text = String(markup || '');
  if (!looksLikeHtml(text)) throw new Error('html must be one HTML document (<!doctype html><html>…</html>)');
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > MAX_INLINE_PAGE) throw new Error(`html up to ${MAX_INLINE_PAGE / 1024} KB (keep pictures out of it: the user's files as asset:<name>, art as inline SVG)`);
  let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:text/html;charset=utf-8;base64,${btoa(bin)}`;
}

/** An inline page's text (base64 or percent-encoded data: URL), or null. */
export function inlinePageText(url) {
  if (!isInlinePage(url)) return null;
  const comma = url.indexOf(',');
  if (comma < 0) return null;
  const head = url.slice(0, comma); const body = url.slice(comma + 1);
  try {
    if (/;base64$/i.test(head)) {
      const bin = atob(body); const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder().decode(bytes);
    }
    return decodeURIComponent(body);
  } catch { return null; }
}

/** A page that may run no code: what would still navigate its frame by itself (<meta http-equiv="refresh">) taken out. */
export function withoutRefresh(html) {
  return String(html || '').replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi, '');
}

/** For a .glvideo: every inline page of PROJECT (html clips at any depth) as a file `pages/<clip id>.html`, its clip pointing
 *  at `asset:pages/<clip id>.html`. → { project (a copy, or PROJECT itself when it has none), files: [{ rel, text }] }. */
export function pagesToFiles(project) {
  const files = [];
  const taken = new Set();
  const walk = (clips) => (clips || []).map((clip) => {
    if (clip && clip.mediaType === 'html' && isInlinePage(clip.url)) {
      const text = inlinePageText(clip.url);
      if (text == null) return clip;
      const base = String(clip.id || 'page').replace(/[^\w-]+/g, '-').slice(0, 60) || 'page';
      let rel = `pages/${base}.html`;
      for (let n = 2; taken.has(rel); n += 1) rel = `pages/${base}-${n}.html`;
      taken.add(rel);
      files.push({ rel, text });
      return { ...clip, url: `asset:${rel}` };
    }
    if (clip && clip.sequence) {
      const inner = walk(clip.sequence.clips);
      return inner.some((c, i) => c !== clip.sequence.clips[i]) ? { ...clip, sequence: { ...clip.sequence, clips: inner } } : clip;
    }
    return clip;
  });
  if (!JSON.stringify(project?.clips || []).includes('data:text/html')) return { project, files };
  return { project: { ...project, clips: walk(project.clips) }, files };
}
