/* Edit: the preview's transform gizmo, as the Video Editor's PreviewTransformOverlay draws and drives it.
   - Drag any layer in the preview to move it (it gets selected on the way); edges and centres snap to the frame's edges
     and centre with a pink guide; Alt drags free.
   - Corner handles scale (the opposite corner stays put; Shift: about the centre).
   - Shapes get a handle mid-side that resizes the shape itself (Width or Height, opposite side pinned; Shift: centred).
   - The round handle above rotates (snaps to 0 / ±90 / ±180 within 4°; Shift: 15° steps; Alt: free).
   It sits on the engine's own selection outline (.glm-sel, frame pixels), in an SVG beside the frame with the frame's
   own transform and writes the layer's own fields through the
   page API: panX / panY (% of the frame from its centre), zoom, rotateZ, shapeWidthPct / shapeHeightPct. */
export function install(STUDIO) {
  const $ = s => document.querySelector(s), api = () => window.GreenLightMotion?.page;
  const NS = 'http://www.w3.org/2000/svg', HANDLE = 10, SNAP = 6;
  const itemOf = id => { for (const ch of (window.GL_LAB_PROJECT?.channels || [])) for (const it of ch.items) if (it.id === id) return it; return {}; };
  const typeOf = id => (window.GL_LAB_PROJECT?.clips || []).find(c => c.id === itemOf(id).clipId)?.mediaType;
  const valueOf = (id, path, d) => { const ed = api()?.edits().itemEdits[id] || {}; const v = ed[path] ?? itemOf(id)[path]; return v ?? d; };
  const frame = () => $('.glm-frame');
  const size = () => ({ w: frame().offsetWidth, h: frame().offsetHeight });
  const unit = () => frame().offsetWidth / Math.max(1, frame().getBoundingClientRect().width);   // frame px per screen px
  const toFrame = e => { const f = frame(), r = f.getBoundingClientRect(); return { x: (e.clientX - r.left) / r.width * f.offsetWidth, y: (e.clientY - r.top) / r.height * f.offsetHeight }; };
  let svg = null, drag = null, guides = [], raf = 0;

  // the selected layer's box: the engine's outline, corners in order (top-left, top-right, bottom-right, bottom-left)
  function geom() {
    const poly = $('.glm-sel polygon'); if (!poly) return null;
    const c = poly.getAttribute('points').trim().split(/\s+/).map(q => { const [x, y] = q.split(',').map(Number); return { x, y }; });
    if (c.length < 4 || c.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return null;
    const xs = c.map(p => p.x), ys = c.map(p => p.y);
    return { c, cx: (c[0].x + c[2].x) / 2, cy: (c[0].y + c[2].y) / 2, ang: Math.atan2(c[1].y - c[0].y, c[1].x - c[0].x),
      left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
  }
  const EDGES = [{ a: 0, b: 1, axis: 'h' }, { a: 1, b: 2, axis: 'w' }, { a: 2, b: 3, axis: 'h' }, { a: 3, b: 0, axis: 'w' }];
  const cursorFor = (dx, dy) => { const a = ((Math.atan2(dy, dx) * 180 / Math.PI) % 180 + 180) % 180; return a < 22.5 || a >= 157.5 ? 'ew-resize' : a < 67.5 ? 'nwse-resize' : a < 112.5 ? 'ns-resize' : 'nesw-resize'; };
  const el = (tag, attrs) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };

  function shown() {
    const p = api();
    return !!(p?.ready && frame() && document.body.classList.contains('rv-mode-edit') && !document.body.classList.contains('original')
      && p.selected() && !p.state().playing && !window.LabEdit?.rebuilding());
  }
  function paint() {
    raf = requestAnimationFrame(paint);
    const f = frame(); if (!f) return;
    if (!svg) { svg = el('svg', { class: 'rv-gizmo', 'aria-hidden': 'true' }); svg.addEventListener('pointerdown', down); }
    // beside the frame, not in it: the frame clips, and a handle near its edge must still show (as in the app)
    if (svg.parentNode !== f.parentNode || svg.previousElementSibling !== f) f.after(svg);
    hookPick();
    const { w, h } = size(); svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    if (svg.style.transform !== f.style.transform || svg.style.width !== w + 'px') Object.assign(svg.style, { width: w + 'px', height: h + 'px', transform: f.style.transform });
    const g = shown() && geom();
    if (!g) { if (svg.childNodes.length) svg.replaceChildren(); return; }
    const u = unit(), hs = HANDLE * u, id = api().selected();
    const key = [id, g.c.map(p => p.x.toFixed(1) + ',' + p.y.toFixed(1)).join(' '), u.toFixed(4), guides.map(q => q.axis + q.v).join()].join('|');
    if (svg.dataset.key === key) return; svg.dataset.key = key;
    const kids = [el('polygon', { class: 'rv-gz-hit', points: g.c.map(p => p.x + ',' + p.y).join(' '), 'data-h': 'move' })];
    g.c.forEach((p, i) => { const r = el('rect', { class: 'rv-gz-handle', x: p.x - hs / 2, y: p.y - hs / 2, width: hs, height: hs, rx: 2 * u, 'data-h': 'scale', 'data-i': i }); r.style.cursor = cursorFor(p.x - g.cx, p.y - g.cy); kids.push(r); });
    if (typeOf(id) === 'shape') EDGES.forEach((e, i) => {
      const a = g.c[e.a], b = g.c[e.b]; if (Math.hypot(b.x - a.x, b.y - a.y) < hs * 3) return;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, r = el('rect', { class: 'rv-gz-handle', x: mx - hs / 2, y: my - hs / 2, width: hs, height: hs, rx: 2 * u, 'data-h': 'edge', 'data-i': i });
      r.style.cursor = cursorFor(mx - g.cx, my - g.cy); kids.push(r);
    });
    const tm = { x: (g.c[0].x + g.c[1].x) / 2, y: (g.c[0].y + g.c[1].y) / 2 }, rh = { x: tm.x + Math.sin(g.ang) * 36 * u, y: tm.y - Math.cos(g.ang) * 36 * u };
    kids.push(el('line', { class: 'rv-gz-stem', x1: tm.x, y1: tm.y, x2: rh.x, y2: rh.y }), el('circle', { class: 'rv-gz-rot', cx: rh.x, cy: rh.y, r: 6 * u, 'data-h': 'rotate' }));
    // guides span the frame only (the gizmo itself may hang past its edge)
    guides.forEach(q => kids.push(el('line', q.axis === 'x' ? { class: 'rv-gz-guide', x1: q.v, y1: 0, x2: q.v, y2: h } : { class: 'rv-gz-guide', x1: 0, y1: q.v, x2: w, y2: q.v })));
    svg.replaceChildren(...kids);
  }

  // writes coalesce to one per frame: every setLayerValue re-renders the page
  let queued = null;
  function write(id, patch) {
    const first = !queued; queued = { id, patch: { ...(queued?.patch || {}), ...patch } };
    if (first) requestAnimationFrame(() => { const q = queued; queued = null; for (const [k, v] of Object.entries(q.patch)) api().setLayerValue(q.id, k, v); });
  }
  function begin(e, mode, id, i) {
    e.preventDefault(); e.stopPropagation();
    if (api().state().playing) api().pause();
    drag = { mode, id, i, p0: toFrame(e), g: null, moved: false,
      panX: +valueOf(id, 'panX', 0), panY: +valueOf(id, 'panY', 0), zoom: +valueOf(id, 'zoom', 1), rot: +valueOf(id, 'rotateZ', 0),
      sw: +valueOf(id, 'shapeWidthPct', 0), sh: +valueOf(id, 'shapeHeightPct', 0) };
    document.body.classList.add('rv-gz-dragging');
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', end); window.addEventListener('pointercancel', end);
  }
  function down(e) {
    const t = e.target.closest('[data-h]'); if (!t || e.button !== 0) return;
    begin(e, t.dataset.h, api().selected(), +t.dataset.i);
  }
  // a press on any layer in the preview: the engine selects it (its own handler still runs), the drag moves it
  function pickDown(e) {
    if (e.button !== 0 || !shownMode()) return;
    const p = toFrame(e), id = api().pickAt(p.x, p.y); if (!id) return;
    e.preventDefault();   // no text selection while dragging; the engine's own handler still selects the layer
    if (api().state().playing) api().pause();
    drag = { mode: 'move', id, p0: p, g: null, moved: false, panX: +valueOf(id, 'panX', 0), panY: +valueOf(id, 'panY', 0) };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', end); window.addEventListener('pointercancel', end);
  }
  const shownMode = () => document.body.classList.contains('rv-mode-edit') && !document.body.classList.contains('original') && !window.LabEdit?.rebuilding();
  function move(e) {
    const d = drag; if (!d) return;
    const p = toFrame(e), u = unit(), { w, h } = size();
    if (!d.moved && Math.hypot(p.x - d.p0.x, p.y - d.p0.y) < 3 * u) return;
    // the box as it was when the drag began: read once, before the first write (a picked layer's outline is up by now)
    if (!d.g) { if (api().selected() !== d.id) return; d.g = geom(); if (!d.g) return; }
    if (!d.moved) { d.moved = true; document.body.classList.add('rv-gz-dragging'); }
    const g = d.g, origin = { x: w / 2 + d.panX / 100 * w, y: h / 2 + d.panY / 100 * h };
    guides = [];
    if (d.mode === 'move') {
      let dx = p.x - d.p0.x, dy = p.y - d.p0.y;
      if (!e.altKey && g) {
        let bx = null, by = null; const th = SNAP * u;
        [g.left, g.cx, g.right].forEach(v => [0, w / 2, w].forEach(t => { const dd = t - (v + dx); if (Math.abs(dd) <= th && (!bx || Math.abs(dd) < Math.abs(bx.d))) bx = { d: dd, t }; }));
        [g.top, g.cy, g.bottom].forEach(v => [0, h / 2, h].forEach(t => { const dd = t - (v + dy); if (Math.abs(dd) <= th && (!by || Math.abs(dd) < Math.abs(by.d))) by = { d: dd, t }; }));
        if (bx) { dx += bx.d; guides.push({ axis: 'x', v: bx.t }); }
        if (by) { dy += by.d; guides.push({ axis: 'y', v: by.t }); }
      }
      write(d.id, { panX: +(d.panX + dx / w * 100).toFixed(2), panY: +(d.panY + dy / h * 100).toFixed(2) });
    } else if (d.mode === 'scale' && g) {
      const a = e.shiftKey ? { x: g.cx, y: g.cy } : g.c[(d.i + 2) % 4];
      const k = Math.hypot(p.x - a.x, p.y - a.y) / (Math.hypot(d.p0.x - a.x, d.p0.y - a.y) || 1);
      const zoom = Math.max(0.1, Math.min(20, d.zoom * k)), f = zoom / d.zoom;
      // the layer turns and scales about its own origin: pin the anchor by moving the origin the same way
      const o = { x: a.x + (origin.x - a.x) * f, y: a.y + (origin.y - a.y) * f };
      write(d.id, { zoom: +zoom.toFixed(4), panX: +((o.x - w / 2) / w * 100).toFixed(2), panY: +((o.y - h / 2) / h * 100).toFixed(2) });
    } else if (d.mode === 'edge' && g) {
      const ed = EDGES[d.i], ox = (g.c[ed.a].x + g.c[ed.b].x) / 2 - g.cx, oy = (g.c[ed.a].y + g.c[ed.b].y) / 2 - g.cy, half = Math.hypot(ox, oy);
      if (half > 1e-6) {
        const nx = ox / half, ny = oy / half, along = (p.x - d.p0.x) * nx + (p.y - d.p0.y) * ny;
        const f = Math.max(0, (2 * half + (e.shiftKey ? 2 * along : along)) / (2 * half));
        const key = ed.axis === 'w' ? 'shapeWidthPct' : 'shapeHeightPct', base = ed.axis === 'w' ? d.sw : d.sh;
        const value = Math.max(0.01, Math.round(base * f * 100) / 100), shift = e.shiftKey ? 0 : half * (value / (base || 1) - 1);
        write(d.id, { [key]: value, ...(shift ? { panX: +(d.panX + nx * shift / w * 100).toFixed(2), panY: +(d.panY + ny * shift / h * 100).toFixed(2) } : {}) });
      }
    } else if (d.mode === 'rotate' && g) {
      let r = d.rot + (Math.atan2(p.y - g.cy, p.x - g.cx) - Math.atan2(d.p0.y - g.cy, d.p0.x - g.cx)) * 180 / Math.PI;
      r = ((r + 180) % 360 + 360) % 360 - 180;
      if (e.shiftKey) r = Math.round(r / 15) * 15;
      else if (!e.altKey) [-180, -90, 0, 90, 180].forEach(a => { if (Math.abs(r - a) < 4) r = a; });
      write(d.id, { rotateZ: +Math.max(-180, Math.min(180, r)).toFixed(2) });
    }
  }
  function end() {
    drag = null; guides = []; document.body.classList.remove('rv-gz-dragging');
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end); window.removeEventListener('pointercancel', end);
  }
  function hookPick() {
    const pick = $('.glm-pick');
    if (pick && !pick.dataset.rvGizmo) { pick.dataset.rvGizmo = '1'; pick.addEventListener('pointerdown', pickDown); }
  }
  window.LabXform = { valueOf, geom, dragging: () => !!drag?.moved };
  const start = () => { if (!api()?.ready || !frame()) { setTimeout(start, 100); return; } cancelAnimationFrame(raf); paint(); };
  start();
  // the page was rebuilt (Add / Duplicate / Delete): the next frame puts the gizmo in the new preview and hooks its pick layer
  window.addEventListener('rv:remount', () => { svg?.remove(); svg = null; });
}
