/*
 * Review notes on the page (reviewNotes.js has the model): where a finished mark goes, and what the page shows of
 * the notes. Three places, picked once at load:
 *
 *   'comments' — a Claude artifact that declares `comments: { customAnchors: true }`: a mark opens the claude.ai
 *                comment composer at that spot, anchored to a name the page reads back (`12.40s · Title · box …`);
 *                the viewer writes the note there and presses Send to Claude, and the agent replies in the thread.
 *                The shell draws the pins; the page reports where they belong at the paused moment (placed()).
 *   'server'   — served by `greenlight-motion review <folder>`: the page's own note field; every change rewrites
 *                <folder>/review/ (notes.json, NOTES.md, one picture per moment) through /__glm/review.
 *   'local'    — anywhere else: the same note field; notes stay in this browser (localStorage) and leave as a zip
 *                (Save notes) or as text (Copy for agent).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  anchorName, layersUnder, markGeometry, momentsOf, noteDetail, noteLabel, notesMarkdown, parseAnchor, zipStore,
  MARK_COLOR,
} from './reviewNotes';

const API = '/__glm/review';

// One mark on a 2D canvas, the way ReviewLayer draws it (the picture an agent gets).
function paintMark(g, mark, n, k) {
  g.save();
  g.strokeStyle = MARK_COLOR;
  g.fillStyle = MARK_COLOR;
  g.lineWidth = 4 * k;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  const badge = (x, y) => {
    g.beginPath(); g.arc(x, y, 17 * k, 0, Math.PI * 2); g.fillStyle = MARK_COLOR; g.fill();
    g.lineWidth = 2.5 * k; g.strokeStyle = '#fff'; g.stroke();
    g.fillStyle = '#fff'; g.font = `700 ${18 * k}px Inter, -apple-system, "Segoe UI", sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(String(n), x, y + 1);
  };
  if (mark.kind === 'pin') badge(mark.x, mark.y);
  else if (mark.kind === 'box') {
    const r = markGeometry(mark).rect;
    g.fillStyle = 'rgba(255,77,79,0.10)'; g.fillRect(r.x, r.y, r.w, r.h); g.strokeRect(r.x, r.y, r.w, r.h);
    badge(r.x, r.y);
  } else if (mark.kind === 'arrow') {
    const a = Math.atan2(mark.y2 - mark.y1, mark.x2 - mark.x1); const h = 22 * k;
    g.beginPath(); g.moveTo(mark.x1, mark.y1); g.lineTo(mark.x2, mark.y2); g.stroke();
    g.beginPath(); g.moveTo(mark.x2, mark.y2);
    g.lineTo(mark.x2 - h * Math.cos(a - 0.45), mark.y2 - h * Math.sin(a - 0.45));
    g.lineTo(mark.x2 - h * Math.cos(a + 0.45), mark.y2 - h * Math.sin(a + 0.45)); g.closePath(); g.fill();
    badge(mark.x1, mark.y1);
  } else {
    g.beginPath();
    mark.pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.stroke();
    badge(mark.pts[0][0], mark.pts[0][1]);
  }
  g.restore();
}

async function pictureOf({ capture, t, notes, size }) {
  const url = await capture(t);
  if (!url) return null;
  const img = new Image();
  img.src = url;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = size.w; c.height = size.h;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0, size.w, size.h);
  const k = Math.max(1, size.h / 1080);
  for (const n of notes) paintMark(g, n.mark, n.n, k);
  return new Promise((ok) => c.toBlob(ok, 'image/png'));
}

export function useReview({ title, slugName, size, fps, rows, pickAt, frameRef, currentTime, playing, seek, capture }) {
  const [mode, setMode] = useState('local');
  const [on, setOn] = useState(false);
  const [tool, setTool] = useState('pin');
  const [notes, setNotes] = useState([]);
  const [composer, setComposer] = useState(null);   // local/server: { mark, t, layers } waiting for its words
  const [pending, setPending] = useState(null);     // comments: the mark the shell's composer is open for
  const [threads, setThreads] = useState([]);       // comments: [{ id, anchor, resolved, active, at }]
  const [status, setStatus] = useState(null);
  const caRef = useRef(null);
  const threadsRef = useRef([]);
  useEffect(() => { threadsRef.current = threads; }, [threads]);
  const nameOf = useMemo(() => {
    const m = new Map(rows.flatMap((r) => r.layers).map((l) => [l.id, l]));
    return (id) => m.get(id) || null;
  }, [rows]);
  const storeKey = `glm-review:${slugName}:${size.w}x${size.h}`;

  // ── where notes go ──
  useEffect(() => {
    let alive = true;
    (async () => {
      // a Claude artifact first: its comments ARE the notes
      try {
        const comments = await window.claude?.use?.('comments');
        if (alive && comments && typeof comments.customAnchors === 'function') {
          const ca = await comments.customAnchors({
            mode: (v) => setOn(Boolean(v)),
            threads: (list) => setThreads((list || []).map((th) => ({ ...th, at: parseAnchor(th.anchor) }))),
            reveal: (id) => { const th = threadsRef.current.find((x) => x.id === id); if (th?.at) seek(th.at.t); },
            composing: (open) => { if (!open) setPending(null); },
          });
          if (!alive) { ca.release(); return; }
          caRef.current = ca;
          setMode('comments');
          return;
        }
      } catch { /* this view anchors comments itself, or has none: the page keeps its own notes */ }
      // served by `greenlight-motion review`
      if (typeof location !== 'undefined' && /^https?:$/.test(location.protocol)) {
        try {
          const r = await fetch(API, { cache: 'no-store' });
          const j = r.ok ? await r.json() : null;
          if (alive && Array.isArray(j?.notes)) { setNotes(j.notes); setMode('server'); return; }
        } catch { /* not served by the CLI */ }
      }
      try {
        const kept = JSON.parse(localStorage.getItem(storeKey) || '[]');
        if (alive && Array.isArray(kept)) setNotes(kept);
      } catch { /* no storage here: notes live for this visit */ }
    })();
    return () => { alive = false; caRef.current?.release(); caRef.current = null; };
  }, [storeKey, seek]);

  // ── keeping them ──
  const uploaded = useRef(new Map());   // moment file → the note ids it was drawn with
  const persist = useCallback(async (next) => {
    if (mode === 'local') {
      try { localStorage.setItem(storeKey, JSON.stringify(next)); } catch { /* kept for this visit */ }
      return;
    }
    if (mode !== 'server') return;
    const moments = momentsOf(next, fps);
    const images = {};
    for (const m of moments) for (const n of m.notes) images[n.n] = m.file;
    try {
      await fetch(API, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ notes: next, markdown: notesMarkdown({ title, size, fps, notes: next, images }) }),
      });
      const keep = new Set();
      for (const m of moments) {
        keep.add(m.file);
        const sig = m.notes.map((n) => `${n.id}:${JSON.stringify(n.mark)}`).join('|');
        if (uploaded.current.get(m.file) === sig) continue;
        const png = await pictureOf({ capture, t: m.t, notes: m.notes, size });
        if (png) await fetch(`${API}/image/${encodeURIComponent(m.file)}`, { method: 'PUT', body: png });
        uploaded.current.set(m.file, sig);
      }
      for (const file of [...uploaded.current.keys()]) {
        if (keep.has(file)) continue;
        await fetch(`${API}/image/${encodeURIComponent(file)}`, { method: 'DELETE' });
        uploaded.current.delete(file);
      }
      setStatus({ text: `Saved to review/ in the project folder: ${next.length} note${next.length === 1 ? '' : 's'}. Tell your agent you left notes.`, tone: 'good' });
    } catch (err) {
      setStatus({ text: `Couldn’t save the notes: ${err?.message || err}`, tone: 'bad' });
    }
  }, [mode, storeKey, fps, title, size, capture]);

  const commit = useCallback((next) => { setNotes(next); persist(next); }, [persist]);

  // ── a finished mark ──
  const describe = useCallback((mark, t) => {
    const ids = layersUnder(mark, (x, y) => pickAt(x, y, t));
    return ids.map((id) => { const l = nameOf(id); return { id, name: l?.name || id, type: l?.type || 'layer' }; });
  }, [pickAt, nameOf]);

  const onFinish = useCallback(async (mark) => {
    const t = currentTime;
    const layers = describe(mark, t);
    if (mode === 'comments' && caRef.current) {
      const ca = caRef.current;
      const note = { t, mark };
      const top = layers[0]?.name || '';
      const r = frameRef.current?.getBoundingClientRect();
      const p = markGeometry(mark).point;
      const at = r ? { x: r.left + (p.x / size.w) * r.width + window.scrollX, y: r.top + (p.y / size.h) * r.height + window.scrollY } : { x: 0, y: 0 };
      setPending(mark);
      try {
        const res = await ca.compose(anchorName(note, top), at, {
          label: noteLabel(note, top), detail: noteDetail(note, { size, fps, layers }), area: mark.kind !== 'pin' && ca.areas,
        });
        if (!res?.opened) setPending(null);
      } catch (err) {
        setPending(null);
        setStatus({ text: `Couldn’t open the comment box (${err?.code || err?.message || err}).`, tone: 'bad' });
      }
      return;
    }
    setComposer({ mark, t, layers });
  }, [currentTime, describe, mode, frameRef, size, fps]);

  const saveComposer = useCallback((text) => {
    if (!composer) return;
    const n = notes.reduce((a, x) => Math.max(a, x.n), 0) + 1;
    const note = { id: `n${Date.now().toString(36)}${n}`, n, t: +composer.t.toFixed(4), mark: composer.mark, text: String(text || '').trim(), layers: composer.layers };
    setComposer(null);
    commit([...notes, note]);
  }, [composer, notes, commit]);

  const add = useCallback((mark, text, t = currentTime) => {
    const n = notes.reduce((a, x) => Math.max(a, x.n), 0) + 1;
    const note = { id: `n${Date.now().toString(36)}${n}`, n, t: +Number(t).toFixed(4), mark, text: String(text || '').trim(), layers: describe(mark, t) };
    commit([...notes, note]);
    return note;
  }, [notes, commit, describe, currentTime]);
  const remove = useCallback((id) => commit(notes.filter((x) => x.id !== id)), [notes, commit]);

  // ── what shows: the marks of the paused moment ──
  const near = useCallback((t) => !playing && Math.abs(t - currentTime) <= 0.75 / (fps || 30), [playing, currentTime, fps]);
  const shown = useMemo(() => {
    const out = [];
    if (mode === 'comments') {
      // the shell draws the pins; the page shows the area a thread covers
      for (const th of threads) {
        if (!th.at || th.resolved || !near(th.at.t) || !(th.at.w || th.at.h)) continue;
        out.push({ key: th.id, mark: { kind: 'box', x1: th.at.x, y1: th.at.y, x2: th.at.x + th.at.w, y2: th.at.y + th.at.h }, pin: false, dim: !th.active });
      }
      if (pending) out.push({ key: 'pending', mark: pending, pin: false });
      return out;
    }
    for (const n of notes) if (near(n.t)) out.push({ key: n.id, n: n.n, mark: n.mark });
    if (composer) out.push({ key: 'draft', mark: composer.mark, pin: false });
    return out;
  }, [mode, threads, notes, pending, composer, near]);

  // comments: tell the shell where each thread's pin belongs at the paused moment (others go to its list)
  useEffect(() => {
    const ca = caRef.current;
    if (mode !== 'comments' || !ca) return undefined;
    const report = () => {
      const r = frameRef.current?.getBoundingClientRect();
      const map = {};
      if (r) {
        for (const th of threads) {
          if (!th.at || !near(th.at.t)) continue;
          map[th.id] = { x: r.left + (th.at.point.x / size.w) * r.width + window.scrollX, y: r.top + (th.at.point.y / size.h) * r.height + window.scrollY };
        }
      }
      try { ca.placed(map); } catch { /* released */ }
    };
    report();
    window.addEventListener('resize', report);
    return () => window.removeEventListener('resize', report);
  }, [mode, threads, near, frameRef, size]);

  const flags = useMemo(() => (mode === 'comments'
    ? threads.filter((th) => th.at && !th.resolved).map((th, i) => ({ key: th.id, n: i + 1, t: th.at.t }))
    : notes.map((n) => ({ key: n.id, n: n.n, t: n.t }))), [mode, threads, notes]);

  // ── handing them over (local) ──
  const markdown = useCallback(() => {
    const images = {};
    for (const m of momentsOf(notes, fps)) for (const n of m.notes) images[n.n] = m.file;
    return notesMarkdown({ title, size, fps, notes, images });
  }, [notes, fps, title, size]);
  const copy = useCallback(async () => {
    try { await navigator.clipboard.writeText(markdown()); setStatus({ text: 'Copied. Paste it to your agent with the pictures from Save notes.', tone: 'good' }); }
    catch { setStatus({ text: 'This browser didn’t allow copying. Use Save notes.', tone: 'bad' }); }
  }, [markdown]);
  const zip = useCallback(async () => {
    const files = [{ name: 'NOTES.md', data: markdown() }, { name: 'notes.json', data: JSON.stringify({ title, size, fps, notes }, null, 1) }];
    for (const m of momentsOf(notes, fps)) {
      const png = await pictureOf({ capture, t: m.t, notes: m.notes, size });
      if (png) files.push({ name: m.file, data: new Uint8Array(await png.arrayBuffer()) });
    }
    return new Blob([zipStore(files)], { type: 'application/zip' });
  }, [markdown, notes, fps, title, size, capture]);

  const toggle = useCallback((v) => {
    const next = typeof v === 'boolean' ? v : !on;
    setOn(next);
    if (!next) { setComposer(null); if (mode === 'comments') caRef.current?.exitMode(); }
  }, [on, mode]);

  return {
    mode, on, toggle, tool, setTool, notes, threads, shown, flags, composer, saveComposer,
    cancelComposer: () => setComposer(null), onFinish, add, remove, copy, zip, markdown, status, setStatus,
    count: mode === 'comments' ? threads.filter((th) => !th.resolved).length : notes.length,
  };
}
