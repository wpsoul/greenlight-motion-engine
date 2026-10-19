/*
 * Review notes on a GreenLight Motion page: a mark the viewer draws on the paused preview (a pin, a box, an arrow or
 * a pen stroke) with their note about it. Each note keeps what an agent needs to fix exactly that: the moment (time
 * and frame), the mark in composition pixels and the layers under it (ids from project.json).
 *
 * Where the notes go is the page's business (PlayerPage.jsx):
 *   - in a Claude artifact, each mark is a comment thread on the artifact (`comments` + customAnchors) that the
 *     viewer sends to Claude; its anchor name, label and detail below are how Claude reads the place;
 *   - served by `greenlight-motion review <folder>`, they are written to <folder>/review/ (NOTES.md, notes.json and
 *     a picture of each moment);
 *   - anywhere else, "Save notes" downloads the same files as one zip and "Copy for agent" copies NOTES.md.
 * Pure functions: no DOM, so Node tests import them.
 */

export const REVIEW_TOOLS = [
  { id: 'pin', key: 'p', label: 'Pin', hint: 'Click a spot' },
  { id: 'box', key: 'b', label: 'Box', hint: 'Drag over an area' },
  { id: 'arrow', key: 'a', label: 'Arrow', hint: 'Drag from the tail to the tip' },
  { id: 'pen', key: 'd', label: 'Draw', hint: 'Draw freely' },
];
export const MARK_COLOR = '#ff4d4f';

const round = (v) => Math.round(Number(v) || 0);
const fix2 = (t) => (Math.round((Number(t) || 0) * 100) / 100).toFixed(2);

/** Too small to mean anything: a click that wobbled while the Box, Arrow or Draw tool was on. */
export function isStray(mark, minPx = 6) {
  if (!mark) return true;
  if (mark.kind === 'pin') return false;
  const r = markGeometry(mark).rect;
  return Math.max(r.w, r.h) < minPx;
}

/** Where a mark points (`point`) and what it covers (`rect`), in composition pixels. */
export function markGeometry(mark) {
  if (mark.kind === 'pin') return { point: { x: mark.x, y: mark.y }, rect: { x: mark.x, y: mark.y, w: 0, h: 0 } };
  if (mark.kind === 'pen') {
    const xs = mark.pts.map((p) => p[0]); const ys = mark.pts.map((p) => p[1]);
    const rect = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    return { point: { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }, rect };
  }
  const rect = { x: Math.min(mark.x1, mark.x2), y: Math.min(mark.y1, mark.y2), w: Math.abs(mark.x2 - mark.x1), h: Math.abs(mark.y2 - mark.y1) };
  if (mark.kind === 'arrow') return { point: { x: mark.x2, y: mark.y2 }, rect };
  return { point: { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }, rect };
}

/** The layers under a mark, top first: `pick(x, y)` is the page's own hit test (a layer id or null). */
export function layersUnder(mark, pick) {
  const { point, rect } = markGeometry(mark);
  const probes = [[point.x, point.y]];
  if (mark.kind === 'arrow') {
    // the tip, and a little back along the shaft (a tip that lands on an edge still names its layer)
    const dx = mark.x1 - mark.x2; const dy = mark.y1 - mark.y2; const len = Math.hypot(dx, dy) || 1;
    probes.push([mark.x2 + (dx / len) * 12, mark.y2 + (dy / len) * 12]);
  } else if (mark.kind === 'box' || mark.kind === 'pen') {
    for (const fx of [0.25, 0.75]) for (const fy of [0.25, 0.75]) probes.push([rect.x + rect.w * fx, rect.y + rect.h * fy]);
  }
  const ids = [];
  for (const [x, y] of probes) {
    const id = pick(x, y);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

const KIND_WORD = { pin: 'pin', box: 'box', arrow: 'arrow', pen: 'drawing' };

/** One line about the mark: where it is, in composition pixels. */
export function markWhere(mark) {
  const { point, rect } = markGeometry(mark);
  if (mark.kind === 'pin') return `a pin at ${round(point.x)}, ${round(point.y)} px`;
  if (mark.kind === 'arrow') return `an arrow from ${round(mark.x1)}, ${round(mark.y1)} pointing at ${round(point.x)}, ${round(point.y)} px`;
  const what = mark.kind === 'box' ? 'a box over' : 'a drawing over';
  return `${what} ${round(rect.x)}–${round(rect.x + rect.w)} × ${round(rect.y)}–${round(rect.y + rect.h)} px`;
}

/**
 * The anchor name of a comment thread: the page's durable name for the spot, and what Claude reads as the thread's
 * location, so it is legible and parseable: `12.40s · Title · box 820,600 280x120` (≤ 128 bytes as UTF-8).
 */
export function anchorName(note, layerName = '') {
  const { point, rect } = markGeometry(note.mark);
  const where = note.mark.kind === 'pin' || note.mark.kind === 'arrow'
    ? `${note.mark.kind} ${round(point.x)},${round(point.y)}`
    : `${note.mark.kind === 'pen' ? 'draw' : 'box'} ${round(rect.x)},${round(rect.y)} ${round(rect.w)}x${round(rect.h)}`;
  const head = `${fix2(note.t)}s · `;
  const tail = ` · ${where}`;
  // no control characters, and no ' · ' inside the name (it separates the anchor's parts)
  let name = [...String(layerName || 'frame')].map((ch) => (ch.charCodeAt(0) < 32 || ch === '\u007f' || ch === '·' ? ' ' : ch)).join('')
    .replace(/\s+/g, ' ').trim() || 'frame';
  const bytes = (s) => new TextEncoder().encode(s).length;
  while (name.length > 1 && bytes(head + name + tail) > 128) name = `${name.slice(0, -2)}…`;
  return head + name + tail;
}

/** The time and place back from an anchor name (null for a thread the page did not name). */
export function parseAnchor(name) {
  const m = /^(\d+(?:\.\d+)?)s · .* · (pin|arrow|box|draw) (-?\d+),(-?\d+)(?: (\d+)x(\d+))?$/.exec(String(name || ''));
  if (!m) return null;
  const x = Number(m[3]); const y = Number(m[4]);
  const w = m[5] != null ? Number(m[5]) : 0; const h = m[6] != null ? Number(m[6]) : 0;
  const area = m[2] === 'box' || m[2] === 'draw';
  return { t: Number(m[1]), kind: m[2], x, y, w, h, point: area ? { x: x + w / 2, y: y + h / 2 } : { x, y } };
}

/** The composer's short location label: `0:12.40 · Approve button`. */
export function noteLabel(note, layerName = '') {
  const t = Number(note.t) || 0;
  const clock = `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, '0')}`;
  return `${clock} · ${layerName || 'the frame'}`.slice(0, 120);
}

/** What Claude keeps beside the anchor (≤ 512 bytes): the moment, the mark and the layer ids under it. */
export function noteDetail(note, { size, fps, layers = [] } = {}) {
  const frame = Math.round((Number(note.t) || 0) * (fps || 30));
  const under = layers.length
    ? `over layer${layers.length > 1 ? 's' : ''} ${layers.slice(0, 4).map((l) => `${l.id} (${l.type}${l.name && l.name !== l.id ? ` "${l.name}"` : ''})`).join(', ')}`
    : 'over no layer (the background)';
  let s = `At ${fix2(note.t)} s (frame ${frame} at ${fps || 30} fps) on the ${size?.w || '?'}×${size?.h || '?'} frame: ${markWhere(note.mark)}, ${under}. Layer ids are the item ids in project.json.`;
  const bytes = (x) => new TextEncoder().encode(x).length;
  while (bytes(s) > 512) s = `${s.slice(0, -4)}…`;
  return s;
}

/** NOTES.md: what the viewer asked for, note by note, for an agent. `images` maps a note's n to its picture. */
export function notesMarkdown({ title, size, fps, notes, images = {} }) {
  const lines = [
    `# Review notes — ${title || 'video'}`,
    '',
    `${notes.length} note${notes.length === 1 ? '' : 's'} from the viewer, in timeline order. Each names the moment, what was marked`
      + ` (composition pixels on the ${size?.w}×${size?.h} frame, origin top left) and the layers under the mark (item ids in`
      + ' project.json). The picture of each moment, with the marks numbered, is next to this file.',
    '',
  ];
  for (const n of [...notes].sort((a, b) => a.t - b.t || a.n - b.n)) {
    const frame = Math.round(n.t * (fps || 30));
    lines.push(`## ${n.n} · ${fix2(n.t)} s (frame ${frame} at ${fps || 30} fps)`);
    lines.push('');
    for (const l of String(n.text || '(no words, just the mark)').split('\n')) lines.push(`> ${l}`);
    lines.push('');
    lines.push(`- ${markWhere(n.mark)} (${KIND_WORD[n.mark.kind]} ${n.n})`);
    lines.push(n.layers?.length
      ? `- under it: ${n.layers.map((l) => `\`${l.id}\` (${l.type}${l.name && l.name !== l.id ? `, "${l.name}"` : ''})`).join(', ')}`
      : '- under it: no layer (the background)');
    if (images[n.n]) lines.push(`- picture: ${images[n.n]}`);
    lines.push('');
  }
  return lines.join('\n');
}

/** The pictures to make: one per moment (notes closer than half a frame share it). */
export function momentsOf(notes, fps = 30) {
  const out = [];
  for (const n of [...notes].sort((a, b) => a.t - b.t)) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.t - n.t) < 0.5 / fps) last.notes.push(n);
    else out.push({ t: n.t, notes: [n] });
  }
  return out.map((m) => ({ ...m, file: `at-${fix2(m.t)}s.png` }));
}

// ── a zip with stored (uncompressed) entries: PNGs are compressed already, and NOTES.md is small ──
let crcTable = null;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** files: [{ name, data: Uint8Array | string }] → the zip's bytes. */
export function zipStore(files) {
  const enc = new TextEncoder();
  const entries = files.map((f) => ({ name: enc.encode(f.name), data: typeof f.data === 'string' ? enc.encode(f.data) : f.data }));
  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const crc = crc32(e.data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); local.setUint32(14, crc, true);
    local.setUint32(18, e.data.length, true); local.setUint32(22, e.data.length, true); local.setUint16(26, e.name.length, true);
    parts.push(new Uint8Array(local.buffer), e.name, e.data);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x0800, true);
    cd.setUint32(16, crc, true); cd.setUint32(20, e.data.length, true); cd.setUint32(24, e.data.length, true);
    cd.setUint16(28, e.name.length, true); cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), e.name);
    offset += 30 + e.name.length + e.data.length;
  }
  const cdSize = central.reduce((a, p) => a + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((a, p) => a + p.length, 0));
  let at = 0;
  for (const p of all) { out.set(p, at); at += p.length; }
  return out;
}
