// What a picture, video or sound file is, read from its bytes — never trusted from a header or a name — and its width /
// height / duration from its headers. Shared by the GreenLight Motion connector (cloud/mcp-worker: links it passes
// through) and the scene script (sceneScript.js: SVG the model draws; the CLI: files in a project's assets/).
// Plain JS, no DOM and no Node APIs: it runs in the Worker, in Node and in the browser.

export const LIMITS = { image: 20 * 1024 * 1024, video: 60 * 1024 * 1024, audio: 30 * 1024 * 1024 };
export const MIME = {
  png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg',
};
export const KIND = { png: 'image', jpg: 'image', gif: 'image', webp: 'image', svg: 'image', mp4: 'video', mov: 'video', webm: 'video', mp3: 'audio', m4a: 'audio', wav: 'audio', ogg: 'audio' };
const ascii = (b, at, n) => String.fromCharCode(...b.subarray(at, at + n));
const u16 = (b, at) => (b[at] << 8) | b[at + 1];
const u32 = (b, at) => ((b[at] << 24) >>> 0) + (b[at + 1] << 16) + (b[at + 2] << 8) + b[at + 3];
const le16 = (b, at) => b[at] | (b[at + 1] << 8);
const le24 = (b, at) => b[at] | (b[at + 1] << 8) | (b[at + 2] << 16);
const le32 = (b, at) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;

/** The file type from its first bytes: 'png' | 'jpg' | … or null. */
export function sniff(b) {
  if (!b || b.length < 12) return null;
  if (b[0] === 0x89 && ascii(b, 1, 3) === 'PNG') return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (ascii(b, 0, 4) === 'GIF8') return 'gif';
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'webp';
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WAVE') return 'wav';
  if (ascii(b, 4, 4) === 'ftyp') {
    const brand = ascii(b, 8, 4);
    if (brand === 'qt  ') return 'mov';
    if (/^M4A|^M4B/.test(brand)) return 'm4a';
    return 'mp4';
  }
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'webm';
  if (ascii(b, 0, 4) === 'OggS') return 'ogg';
  if (ascii(b, 0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return 'mp3';
  const head = new TextDecoder().decode(b.subarray(0, Math.min(b.length, 4096))).replace(/^﻿/, '').trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return 'svg';
  return null;
}

// ISO BMFF (MP4 / MOV / M4A): the movie's duration (mvhd) and the first video track's size (tkhd)
function mp4Info(b) {
  const out = {};
  const walk = (from, to, depth) => {
    let at = from;
    while (at + 8 <= to && depth < 8) {
      let size = u32(b, at); const type = ascii(b, at + 4, 4); let head = 8;
      if (size === 1) { size = u32(b, at + 8) * 2 ** 32 + u32(b, at + 12); head = 16; } else if (size === 0) size = to - at;
      if (size < head || at + size > to) break;
      if (['moov', 'trak', 'mdia', 'minf'].includes(type)) walk(at + head, at + size, depth + 1);
      else if (type === 'mvhd' && out.duration == null) {
        const v = b[at + head];
        const ts = v === 1 ? u32(b, at + head + 20) : u32(b, at + head + 12);
        const d = v === 1 ? u32(b, at + head + 24) * 2 ** 32 + u32(b, at + head + 28) : u32(b, at + head + 16);
        if (ts) out.duration = +(d / ts).toFixed(3);
      } else if (type === 'tkhd' && !out.width) {
        const end = at + size;
        const w = u32(b, end - 8) / 65536; const h = u32(b, end - 4) / 65536;
        if (w > 0 && h > 0) { out.width = Math.round(w); out.height = Math.round(h); }
      }
      at += size;
    }
  };
  walk(0, b.length, 0);
  return out;
}

export function svgSize(text) {
  const tag = (/<svg\b[^>]*>/i.exec(text) || [''])[0];
  const attr = (n) => { const m = new RegExp(`\\s${n}\\s*=\\s*["']\\s*([\\d.]+)\\s*(px)?\\s*["']`, 'i').exec(tag); return m ? Number(m[1]) : null; };
  let w = attr('width'); let h = attr('height');
  const vb = /\sviewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*["']/i.exec(tag);
  if ((!w || !h) && vb) { const vw = Number(vb[1]); const vh = Number(vb[2]); if (w && !h) h = (w * vh) / vw; else if (h && !w) w = (h * vw) / vh; else { w = vw; h = vh; } }
  return w && h ? { width: Math.round(w), height: Math.round(h) } : {};
}

/** { width, height, duration } read from the file's headers (what is there to read). */
export function probe(b, type) {
  try {
    if (type === 'png') return { width: u32(b, 16), height: u32(b, 20) };
    if (type === 'gif') return { width: le16(b, 6), height: le16(b, 8) };
    if (type === 'jpg') {
      let at = 2;
      while (at + 9 < b.length) {
        if (b[at] !== 0xff) { at += 1; continue; }
        const m = b[at + 1];
        if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { height: u16(b, at + 5), width: u16(b, at + 7) };
        if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { at += 2; continue; }
        at += 2 + u16(b, at + 2);
      }
      return {};
    }
    if (type === 'webp') {
      const chunk = ascii(b, 12, 4);
      if (chunk === 'VP8X') return { width: le24(b, 24) + 1, height: le24(b, 27) + 1 };
      if (chunk === 'VP8L') { const v = le32(b, 21); return { width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1 }; }
      if (chunk === 'VP8 ') return { width: le16(b, 26) & 0x3fff, height: le16(b, 28) & 0x3fff };
      return {};
    }
    if (type === 'svg') return svgSize(new TextDecoder().decode(b.subarray(0, Math.min(b.length, 65536))));
    if (type === 'mp4' || type === 'mov' || type === 'm4a') return mp4Info(b);
    if (type === 'wav') {
      let at = 12; let rate = 0;
      while (at + 8 <= b.length) {
        const id = ascii(b, at, 4); const size = le32(b, at + 4);
        if (id === 'fmt ') rate = le32(b, at + 16);
        if (id === 'data' && rate) return { duration: +(size / rate).toFixed(3) };
        at += 8 + size + (size & 1);
      }
    }
  } catch { /* a truncated header: nothing read */ }
  return {};
}

/** An SVG the model wrote → a data url for the project (and its size). */
export function svgDataUrl(markup) {
  const text = String(markup || '');
  if (!/<svg[\s>]/i.test(text)) throw new Error('svg must be SVG markup (<svg …>…</svg>)');
  if (text.length > 512 * 1024) throw new Error('svg up to 512 KB');
  const bytes = new TextEncoder().encode(text);
  let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { url: `data:image/svg+xml;base64,${btoa(bin)}`, ...svgSize(text) };
}
