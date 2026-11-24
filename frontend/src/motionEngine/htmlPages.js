/*
 * GreenLight Motion Engine — HTML layers outside GreenLight Dash.
 *
 * An html clip (`mediaType: "html"`) is drawn LIVE by the editor's own live layer (videoEditor/htmlLive.js): the page runs
 * in a frame inside a canvas and the browser draws it into the layer (HTML-in-canvas: Chrome 157 and later, no flag). In
 * the app the backend serves the page with the bake's clock in it; here there is no server, so this module hands the live
 * layer the page's text itself, which it loads as the frame's srcdoc. A page is
 *   - one of the project's files, `asset:<page>.html`: its own files beside it are written in (htmlPageText.js), or
 *   - a page the model wrote, kept in the project as a `data:text/html` URL (htmlPageText.js htmlDataUrl).
 *
 * Scripts (setHtmlPageScripts): on (the default: the CLI, a page the user opens from their own folder), the page runs with
 * the bake's clock as its first script, and its scripts, CSS and media all follow the video's time. Off (the chat
 * connector's page, a shared link): a srcdoc page has the host page's origin, so its scripts would run as that page — in a
 * chat they could talk to the chat as the video page, on a shared link as the GreenLight server. Then nothing in the page
 * runs; the live layer sets its CSS animations, SVG animation and media from outside.
 *
 * Only a clip with NO bake is drawn live. One that carries a bake (`prerender`: a film made before, a project that came
 * from GreenLight Dash) plays the bake, as it always did outside the app: a Dash page may count on what only the app's
 * server gives it (media from other sites, a HyperFrames runtime, files beside it that an export does not carry), and
 * drawn without those it would show another picture than its bake. In a browser that cannot draw pages a clip with no
 * bake is empty.
 */
import { htmlLiveSupported, setHtmlLivePageSource } from '../components/videoEditor/htmlLive';
import { HTML_CLIP_CLOCK } from './htmlClipClock';
import { injectHead, inlinePageFiles, isInlinePage, inlinePageText, withoutRefresh } from './htmlPageText';

let host = { resolver: () => null, claims: () => false };
let scripts = true;             // setHtmlPageScripts
const loaded = new WeakMap();   // resolver → Map(`${scripts}|${ref}` → Promise<{ text, version } | null>)
const inlineLoaded = new Map(); // the same for inline pages, which need no resolver
const versions = new Map();     // ref → the version of the page the active resolver gives (htmlPageVersions)
const sources = new Map();      // `${scripts}|${ref}` → what the live layer is handed for it (asked every frame)
const keyRefs = new Map();      // a source's key → its ref (htmlLayerStatus)
const liveRefs = new Set();     // the pages of clips with no bake, in the project loaded last: the ones drawn live
let inlineCount = 0;

function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return `f${(h >>> 0).toString(16)}-${text.length}`;
}
async function versionOf(text) {
  try {
    const sum = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
    return [...new Uint8Array(sum)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return hash(text);   // no SubtleCrypto (not a secure context): enough to tell two versions of a page apart
  }
}

// The page's own text (its files written in), then what the frame loads: with the clock as its first script, or with
// nothing that runs by itself.
async function readPage(ref, resolver) {
  let own;
  if (isInlinePage(ref)) own = inlinePageText(ref);
  else {
    const blob = resolver ? await resolver.blob(ref) : null;
    own = blob ? await blob.text() : null;
  }
  if (typeof own !== 'string') return null;
  if (resolver) own = await inlinePageFiles(own, isInlinePage(ref) ? 'inline:' : ref, (file) => resolver.url(file));
  return { own, version: await versionOf(own) };
}
function pageOf(ref, resolver, withScripts = scripts) {
  const inline = isInlinePage(ref);
  if (!inline && !resolver) return Promise.resolve(null);
  let pages = inline ? inlineLoaded : loaded.get(resolver);
  if (!pages) { pages = new Map(); loaded.set(resolver, pages); }
  const key = `${withScripts}|${ref}`;
  if (!pages.has(key)) {
    pages.set(key, readPage(ref, resolver).then((page) => (page ? {
      text: withScripts ? injectHead(page.own, `<script>${HTML_CLIP_CLOCK}</script>`) : withoutRefresh(page.own),
      version: page.version,
    } : null)).catch(() => null));
  }
  return pages.get(key);
}

/** Whether the pages of HTML layers may run their scripts here (see the header). Pages already on screen keep how they
 *  were loaded; the next draw loads them again the new way. */
export function setHtmlPageScripts(on) {
  scripts = on !== false;
}

/** Wire the live layer to the engine's files. `resolver()`: the active asset resolver; `claims(ref)`: this reference is a
 *  file of the page's own (not one GreenLight Dash serves). */
export function installHtmlPages({ resolver, claims }) {
  host = { resolver, claims };
  setHtmlLivePageSource((ref) => {
    if (typeof ref !== 'string' || !liveRefs.has(ref)) return null;
    const inline = isInlinePage(ref);
    if (!inline && (!host.claims(ref) || !host.resolver())) return null;
    const id = `${scripts}|${ref}`;
    let source = sources.get(id);
    if (!source) {
      // the live layer keys its pages by this (an inline page's URL is the whole page: a short name stands for it)
      const key = `${inline ? `inline:${++inlineCount}` : ref}${scripts ? '' : '#no-scripts'}`;
      const withScripts = scripts;
      source = { key, scripts: withScripts, load: () => pageOf(ref, host.resolver(), withScripts).then((page) => page?.text || null) };
      sources.set(id, source);
      keyRefs.set(key, ref);
    }
    return source;
  });
}

/** A project is being loaded with RESOLVER: read this html clip's page. Resolves to its version, or null: no such file. */
export async function htmlPageVersion(ref, resolver) {
  const page = await pageOf(ref, resolver);
  if (page) versions.set(ref, page.version);
  else versions.delete(ref);
  return page ? page.version : null;
}

/** The project just loaded: LIVE are the pages of its clips with no bake, BAKED the pages of clips that play a bake. A page
 *  both kinds of clip use is drawn live. */
export function setHtmlLivePages(live, baked) {
  for (const ref of baked) if (!live.has(ref)) liveRefs.delete(ref);
  for (const ref of live) liveRefs.add(ref);
}

/** ref → version of every page read so far (htmlClips.js `shas`): a page whose file changed reloads. */
export function htmlPageVersions() {
  return Object.fromEntries(versions);
}

// Whether a page in a frame of this window can be reached and drawn: a window with an opaque origin (a host that sandboxes
// it without allow-same-origin) gives its frames an origin of their own, and Chrome then draws nothing of them.
let reach = null;
function reachable() {
  if (reach) return reach;
  reach = new Promise((resolve) => {
    if (typeof document === 'undefined' || !document.body) { resolve(false); return; }
    try {
      const f = document.createElement('iframe');
      f.setAttribute('sandbox', 'allow-same-origin');
      f.style.cssText = 'position:fixed;left:-10px;top:-10px;width:1px;height:1px;border:0;visibility:hidden;';
      const done = (ok) => { try { f.remove(); } catch { /* gone */ } resolve(ok); };
      const timer = setTimeout(() => done(false), 3000);
      f.addEventListener('load', () => {
        clearTimeout(timer);
        let ok = false;
        try { ok = !!f.contentDocument?.body; } catch { ok = false; }
        done(ok);
      }, { once: true });
      f.srcdoc = '<!doctype html><body></body>';
      document.body.appendChild(f);
    } catch { resolve(false); }
  });
  return reach;
}

/** The HTML layers here: can this browser draw pages (`supported`), can this window reach a page's frame (`reachable`),
 *  do pages run their scripts, the pages drawn live, and the pages that could not be drawn (with the reason). `refs`: also
 *  `asked`, the references of the pages the live layer has asked for so far (the CLI's check waits for all of them). */
export async function htmlLayerStatus({ refs = false } = {}) {
  const pages = typeof window !== 'undefined' && window.__glHtmlLive ? window.__glHtmlLive.pages() : [];
  const name = (ref) => (isInlinePage(ref) ? `inline page (${Math.round(ref.length / 1024)} KB)` : ref);
  const failed = new Map();
  for (const p of pages) if (p.failed && p.failed !== 'disposed' && keyRefs.has(p.url)) failed.set(name(keyRefs.get(p.url)), p.failed);
  return {
    supported: htmlLiveSupported(),
    reachable: await reachable(),
    scripts,
    live: [...liveRefs].map(name),
    failed: [...failed].map(([page, why]) => ({ page, why })),
    ...(refs ? { asked: [...new Set(keyRefs.values())] } : {}),
  };
}
