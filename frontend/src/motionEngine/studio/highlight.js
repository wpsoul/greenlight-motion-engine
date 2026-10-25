/* global GL_LAB_PROJECT */   // window globals the studio parts share (studio/index.js)
/* Highlight mode of the review lab: pick the parts you like from every source, in the order of the new cut.
   Ported from the KICKSTAND highlight editor (board Test_Style_Engine) onto the engine page. Owner's changes:
   no key-explanation row in the range panel; Play range loops the range; the timeline's Loop button is now
   Play, which does the same; a note box beside Add highlight (the new range's note, or the edited highlight's).
   Frames are 1/fps of the shared timeline, ranges inclusive. A card over rendered videos gives each source its own
   cuts (source.cuts, frames) and the music's beats (RV_CONFIG.beats): the ruler shows the beats, each filmstrip its
   source's cuts, and a selection snaps to both. The lab's film uses its keyframes for all three. */
export function install(STUDIO) {
  const $ = s => document.querySelector(s), api = () => window.GreenLightMotion?.page;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const svg = (p, w = 14) => `<svg width="${w}" height="${w}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
  const IC = {
    play: w => svg('<polygon points="6 4 19 12 6 20 6 4" fill="currentColor"/>', w),
    pause: w => svg('<rect x="6" y="4" width="4" height="16" fill="currentColor"/><rect x="14" y="4" width="4" height="16" fill="currentColor"/>', w),
    in: svg('<polyline points="10 4 5 4 5 20 10 20"/><line x1="10" y1="12" x2="20" y2="12"/><polyline points="16 8 20 12 16 16"/>'),
    out: svg('<polyline points="14 4 19 4 19 20 14 20"/><line x1="4" y1="12" x2="14" y2="12"/><polyline points="10 8 14 12 10 16"/>'),
    add: w => svg('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>', w),
    clear: svg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'),
    snap: svg('<path d="M5 3v8a7 7 0 0 0 14 0V3"/><line x1="5" y1="7" x2="9" y2="7"/><line x1="15" y1="7" x2="19" y2="7"/><line x1="9" y1="3" x2="9" y2="11"/><line x1="15" y1="3" x2="15" y2="11"/>'),
    scissors: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.12 15.88M14.47 14.48 20 20M8.12 8.12 12 12"/></svg>',
    close: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6"/></svg>',
    list: svg('<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>', 12),
    star: w => svg('<path d="m12 3.2 2.5 5.1 5.7.9-4.1 4 1 5.6L12 16.2l-5.1 2.6 1-5.6-4.1-4 5.7-.9z"/>', w),
    edit: svg('<path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>', 12),
    up: svg('<polyline points="18 15 12 9 6 15"/>', 13),
    down: svg('<polyline points="6 9 12 15 18 9"/>', 13),
    del: svg('<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>', 12),
    toHead: svg('<path d="M7 3h10l-5 6z" fill="currentColor"/><line x1="12" y1="9" x2="12" y2="21"/>', 12)
  };
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };
  const RV = () => window.RV, CFG = window.RV_CONFIG || {};
  let N = 240, FPS = 30, KEYS = [], tl, panel, ruler, ph, rng, inm, snapg, lanes = {}, tracks = {}, films = {}, sprites = {};
  let tlOn = false, hls = [], sel = null, draftNote = '', edit = null, edge = 'b', snapOn = true, pr = null, drag = null, shown = 0, reel = null, isOpen = false, waitPlay = 0;
  const cur = () => RV()?.cur() || 'A';
  const SRC = k => RV()?.sources().find(s => s.k === k) || { k, title: k, col: '#a78bfa', sub: '' };
  const BEATS = () => CFG.beats || KEYS, CUTS = k => SRC(k).cuts || KEYS;
  const SNAPS = k => (CFG.beats || SRC(k).cuts) ? [...new Set([...CUTS(k), ...(CFG.beats || [])])].filter(f => f > 0 && f < N) : KEYS;
  const s2 = f => (f / FPS).toFixed(2);
  const key = () => RV().storeKey + '-hl';
  function load() { try { const raw = JSON.parse(localStorage.getItem(key()) || '[]'); const ks = RV().sources().map(s => s.k); hls = raw.filter(h => h && ks.includes(h.k) && isFinite(h.a) && isFinite(h.b)).map(clean); } catch { hls = []; } hls.forEach(h => { h.a = clamp(h.a, 0, N - 1); h.b = clamp(h.b, h.a, N - 1); }); }
  function clean(h) { return { k: String(h.k), a: h.a | 0, b: h.b | 0, note: String(h.note || ''), must: !!h.must }; }
  function store() { try { localStorage.setItem(key(), JSON.stringify(hls.map(clean))); } catch {} RV()?.changed(); }
  function toast(t) { window.LabSide?.toast(t); }

  // ── playback through the engine page (seek pauses it, so a loop seeks and then plays again) ──
  const st = () => api().state();
  const fr = () => clamp(Math.floor(st().playhead * FPS + 1e-3), 0, N - 1);
  // the part under the playhead lights up (the engine-2 page's sections)
  let partEls = [], partOn = -1;
  function paintHead(f) {
    if (ph) ph.style.left = (f / N * 100) + '%';
    const parts = window.RV_PARTS || []; let k = -1; parts.forEach((p, i) => { if (Math.round(p[1] * FPS) <= f) k = i; });
    if (k !== partOn) { partOn = k; partEls.forEach((el, i) => el.classList.toggle('is-on', i === k)); }
  }
  function seek(f) { f = clamp(f, 0, N - 1); api().seek(f / FPS); shown = f; paintHead(f); }
  // The page re-renders before it reports playing again; until then a stopped state is not the viewer's pause.
  function playSoon() { waitPlay = performance.now(); requestAnimationFrame(() => requestAnimationFrame(() => { if (!st().playing) api().play(); })); }
  function pauseAll() { api().pause(); }
  function pick(k, o = {}) {
    if (k === cur()) return true;
    if (reel && !o.fromReel) stopReel();
    if (edit && !o.keepEdit) doneEdit(true);
    if (!o.keepRange) pr = null;
    if (!RV().setSource(k)) return false;
    sel = null; renderAll(); return true;
  }

  // ── ranges ──
  function active() { if (edit) return { a: edit.h.a, b: edit.h.b, kind: 'edit' }; if (sel && sel.b != null) return { a: sel.a, b: sel.b, kind: 'sel' }; return null; }
  function target() { return edit ? edit.h : ((sel && sel.b != null) ? sel : null); }
  function setEdge(e, f) { const h = target(); if (!h) return false; if (e === 'a') h.a = clamp(f, 0, h.b - 3); else h.b = clamp(f, h.a + 3, N - 1); return true; }
  function snapB(bd, alt) { // a boundary (0..N), snapped to the film's keyframes within 3 frames
    if (alt === snapOn) return { b: bd, c: null };
    let best = bd, d = 4, c = null; SNAPS(cur()).forEach(x => { const dd = Math.abs(x - bd); if (dd < d) { d = dd; best = x; c = x; } }); return { b: best, c };
  }
  function markIn() {
    if (reel) stopReel(); const f = fr();
    if (edit) { setEdge('a', f); edge = 'a'; renderAll(); return; }
    if (sel && sel.b != null) { if (f > sel.b - 3) sel = { a: f, b: null }; else sel.a = f; } else sel = { a: f, b: null };
    edge = 'a'; renderAll();
  }
  function markOut() {
    if (reel) stopReel(); let f = fr();
    if (edit) { setEdge('b', f); edge = 'b'; renderAll(); return; }
    let a = (sel && sel.a != null) ? sel.a : Math.max(0, f - 30);
    if (f < a) { const t = a; a = f; f = t; }
    if (f - a < 3) { a = clamp(f - 3, 0, N - 4); f = a + 3; toast('A highlight is at least 4 frames'); }
    sel = { a, b: f }; edge = 'b'; renderAll();
  }
  function clearSel() { if (pr?.kind === 'range') { pr = null; pauseAll(); } sel = null; draftNote = ''; renderAll(); }
  function add() {
    if (edit) { doneEdit(); return; }
    if (!sel || sel.b == null) { toast(sel ? 'Now set the out, or drag on the filmstrip' : 'Drag on the filmstrip, or mark an in and an out first'); return; }
    const a = Math.min(sel.a, sel.b), b = Math.max(sel.a, sel.b); if (b - a + 1 < 4) { toast('A highlight is at least 4 frames'); return; }
    if (pr?.kind === 'range') { pr = null; pauseAll(); }
    hls.push({ k: cur(), a, b, note: draftNote.trim(), must: false }); sel = null; draftNote = ''; store(); renderAll();
    panel.querySelectorAll('.hl-it')[hls.length - 1]?.scrollIntoView({ block: 'nearest' });
    toast('Added #' + hls.length + ' · ' + ((b - a + 1) / FPS).toFixed(2) + ' s');
  }
  function nudge(e, d) {
    const h = target(); if (!h) return; if (reel) stopReel();
    const looping = pr?.kind === 'range'; if (!looping) { pauseAll(); pr = null; } edge = e;
    setEdge(e, (e === 'a' ? h.a : h.b) + d); if (!looping) seek(e === 'a' ? h.a : h.b); renderAll();
  }
  function toPlayhead(e) { if (!target()) { if (e === 'a') markIn(); else markOut(); return; } setEdge(e, fr()); edge = e; renderAll(); }

  // ── edit a highlight's range ──
  function startEdit(i) {
    const h = hls[i]; if (!h) return; if (reel) stopReel();
    if (edit && edit.h !== h) doneEdit(true);
    if (edit && edit.h === h) { seek(h.a); return; }
    if (cur() !== h.k && !pick(h.k)) return;
    pauseAll(); pr = null; sel = null; edit = { h, a0: h.a, b0: h.b, note0: h.note }; edge = 'a'; seek(h.a); renderAll();
    panel.querySelectorAll('.hl-it')[i]?.scrollIntoView({ block: 'nearest' });
  }
  function doneEdit(quiet) {
    if (!edit) return; const h = edit.h, ch = (h.a !== edit.a0 || h.b !== edit.b0 || h.note !== edit.note0); edit = null;
    if (pr?.kind === 'range') { pr = null; pauseAll(); }
    if (ch) store(); renderAll(); if (!quiet && ch) toast('Range kept · f' + h.a + '–' + h.b);
  }
  function cancelEdit() { if (!edit) return; const noteChanged = edit.h.note !== edit.note0; edit.h.a = edit.a0; edit.h.b = edit.b0; edit.h.note = edit.note0; const a = edit.a0; edit = null; pr = null; if (noteChanged) store(); seek(a); renderAll(); toast('Edit cancelled'); }

  // ── playing a range: the selection or edited highlight loops (Play range, Play, P), one item or the reel plays once ──
  function playRange(o) {
    if (cur() !== o.k && !pick(o.k, { keepEdit: true, keepRange: true, fromReel: !!o.onEnd })) return;
    pr = o; const r = o.get(); seek(r[0]); playSoon(); renderAll();
  }
  function playActive() {
    if (reel) stopReel();
    if (pr?.kind === 'range') { pr = null; pauseAll(); renderAll(); return; }
    if (!active()) { toast('No range yet: drag on the filmstrip, or mark an in and an out'); return; }
    playRange({ kind: 'range', k: cur(), loop: true, get: () => { const x = active(); return x ? [x.a, x.b] : [0, N - 1]; } });
  }
  function endOfRange() {
    const o = pr;
    if (o.onEnd) { pr = null; o.onEnd(); return; }
    const r = o.get();
    if (o.loop) { api().seek(r[0] / FPS); shown = r[0]; paintHead(r[0]); playSoon(); }
    else { pr = null; pauseAll(); seek(r[1]); renderAll(); }
  }
  function playPause() {
    if (reel) { stopReel(); return; }
    if (st().playing) { pauseAll(); if (pr) { pr = null; renderAll(); } return; }
    if (fr() >= N - 1) seek(0); api().play();
  }
  function step(d) { if (reel) stopReel(); pauseAll(); pr = null; seek(fr() + d); renderAll(); }
  function tick() {
    if ((isOpen || tlOn) && api()?.ready) {
      const s = st(), f = clamp(Math.floor(s.playhead * FPS + 1e-3), 0, N - 1);
      if (f !== shown && !drag) { shown = f; paintHead(f); }
      if (isOpen && waitPlay && (s.playing || performance.now() - waitPlay > 600)) waitPlay = 0;
      if (isOpen && pr && !waitPlay) {
        const r = pr.get(), end = r[1] >= N - 2 ? N - 2 : r[1] + 1;   // stop short of the engine's own end-of-film loop
        if (s.playing) { if (f >= end || f < r[0] - 1) endOfRange(); }
        else { pr = null; if (reel) stopReel(); else renderAll(); }      // paused from the transport
      }
    }
    requestAnimationFrame(tick);
  }

  // ── reel: every highlight once, in list order ──
  function startReel() { if (!hls.length) { toast('Add a highlight first'); return; } if (edit) doneEdit(true); sel = null; reel = { i: -1 }; reelNext(); }
  function reelNext() {
    if (!reel) return; reel.i++; if (reel.i >= hls.length) { stopReel(); toast('Reel finished'); return; }
    const h = hls[reel.i]; renderAll(); playRange({ kind: 'reel', k: h.k, get: () => [h.a, h.b], onEnd: reelNext });
    panel.querySelectorAll('.hl-it')[reel.i]?.scrollIntoView({ block: 'nearest' });
  }
  function stopReel() { if (!reel) return; reel = null; pr = null; pauseAll(); RV()?.reel(''); renderAll(); }

  // ── build ──
  function keyFrames() {
    const set = new Set();
    for (const ch of GL_LAB_PROJECT.channels) for (const it of ch.items) {
      const t0 = it.trimStart || 0, len = (it.trimEnd ?? 8) - t0;
      set.add(Math.round(t0 * FPS)); set.add(Math.round((t0 + len) * FPS));
      for (const track of Object.values(it.propertyKeyframes || {})) for (const kf of track) set.add(Math.round((t0 + kf.position / 100 * len) * FPS));
    }
    return [...set].filter(f => f > 0 && f < N).sort((a, b) => a - b);
  }
  function build() {
    FPS = st().fps || 30; N = Math.round(api().duration * FPS); KEYS = keyFrames();
    const srcs = RV().sources();
    tl = el('section', 'hl-tl'); tl.setAttribute('aria-label', 'Highlight timeline');
    const sec = []; for (let s = 0; s <= api().duration; s++) sec.push(`<span class="hl-secm" style="left:${(s * FPS / N * 100).toFixed(4)}%">${s}s</span>`);
    const beats = BEATS().map(f => `<i class="hl-beat" style="left:${(f / N * 100).toFixed(4)}%"></i>`).join('');
    tl.innerHTML = `<div class="hl-tlbar"><div class="hl-tltools">
      <button class="hl-tsb" type="button" data-a="in" title="In at the playhead (I)">${IC.in}<span>In · I</span></button>
      <button class="hl-tsb" type="button" data-a="out" title="Out at the playhead (O)">${IC.out}<span>Out · O</span></button>
      <button class="hl-tsb hl-addb" type="button" data-a="add" title="Add the selection (Enter)">${IC.add(14)}<span class="hl-tsb-l">Add</span></button>
      <button class="hl-tsb" type="button" data-a="clear" title="Clear the selection (Esc)">${IC.clear}<span>Clear</span></button>
      <i class="hl-tsep"></i>
      <button class="hl-tsb" type="button" data-a="play" title="Play the range in a loop (P)"><span class="hl-tsb-ic"></span><span class="hl-tsb-l">Play</span></button>
      <button class="hl-tsb hl-on" type="button" data-a="snap" aria-pressed="true" title="${CFG.beats ? 'Snap to the cuts and the beats' : 'Snap to the film\'s keyframes'} (hold Alt to invert)">${IC.snap}<span>Snap</span></button>
      </div><div class="hl-tlhint"></div></div>
      <div class="hl-tlbody"><div class="hl-rrow"><div class="hl-lab hl-rlab">${CFG.beats ? 'TIME · BEATS' : 'TIME · KEYS'}</div><div class="hl-lane hl-ruler">${sec.join('')}${beats}</div></div>
      ${(window.RV_PARTS || []).length ? `<div class="hl-prow"><div class="hl-lab hl-rlab">PARTS</div><div class="hl-lane hl-parts">${window.RV_PARTS.map((p, i, all) => { const a = Math.round(p[1] * FPS), b = i + 1 < all.length ? Math.round(all[i + 1][1] * FPS) : N; return `<span class="hl-part" data-i="${i}" title="${p[0]} · ${p[2] || ''} (${(a / FPS).toFixed(2)}–${(b / FPS).toFixed(2)} s)" style="left:${(a / N * 100).toFixed(4)}%;width:${((b - a) / N * 100).toFixed(4)}%"><i></i><span>${p[0]}</span></span>`; }).join('')}</div></div>` : ''}
      ${srcs.map(s => `<div class="hl-track" data-k="${s.k}"><div class="hl-lab" title="${s.title}${srcs.length > 1 ? ' · key ' + (srcs.indexOf(s) + 1) : ''}"><i class="hl-dot" style="background:${s.col}"></i><span class="hl-lab-tx"><b>${s.k}</b><small>${s.title.replace(/^[A-Z]+ · /, '')}</small></span><em class="hl-lab-n"></em></div><div class="hl-lane" data-k="${s.k}"><div class="hl-srcclip"><canvas class="hl-film"></canvas>${CUTS(s.k).map(f => `<i class="hl-cut" style="left:${(f / N * 100).toFixed(4)}%"></i>`).join('')}<span class="hl-srcname">${s.title}</span></div></div></div>`).join('')}
      <div class="hl-phl"><div class="hl-ph"><div class="hl-ph-line"></div><div class="hl-ph-head"></div></div></div></div>`;
    $('.glm-tlwrap').append(tl);
    ruler = tl.querySelector('.hl-ruler'); ph = tl.querySelector('.hl-ph'); partEls = [...tl.querySelectorAll('.hl-part')]; partOn = -1;
    tl.querySelectorAll('.hl-track').forEach(t => { tracks[t.dataset.k] = t; lanes[t.dataset.k] = t.querySelector('.hl-lane'); films[t.dataset.k] = t.querySelector('.hl-film'); });
    rng = el('div', 'hl-rng', '<span class="hl-rng-lab"></span><span class="hl-hd hl-hd-a" title="Drag the in (snaps to keyframes, Alt: free)"><i></i></span><span class="hl-hd hl-hd-b" title="Drag the out (snaps to keyframes, Alt: free)"><i></i></span>');
    inm = el('div', 'hl-inm', '<b></b>'); snapg = el('div', 'hl-snapg');

    panel = el('div', 'hl-panel'); panel.setAttribute('aria-label', 'Range and highlights');
    const edgeRow = (e, label, k) => `<div class="hl-field hl-edge" data-e="${e}"><button class="hl-flab hl-edgepick" type="button" data-e="${e}" title="Pick this edge for nudging (${k})">${label}<kbd class="hl-kbd">${k}</kbd></button><span class="hl-nudge"><button class="hl-nb" type="button" data-e="${e}" data-d="-10" title="10 frames earlier">−10</button><button class="hl-nb" type="button" data-e="${e}" data-d="-1" title="1 frame earlier">−1</button><span class="hl-fval" data-v="${e}">—</span><button class="hl-nb" type="button" data-e="${e}" data-d="1" title="1 frame later">+1</button><button class="hl-nb" type="button" data-e="${e}" data-d="10" title="10 frames later">+10</button><button class="hl-tph" type="button" data-e="${e}" title="Set the ${label.toLowerCase()} to the playhead (${label[0]})" aria-label="Set the ${label.toLowerCase()} to the playhead">${IC.toHead}</button></span></div>`;
    panel.innerHTML = `<div class="hl-selh"><span class="hl-selic">${IC.scissors}</span><div class="hl-selc"><strong class="hl-title"></strong><small class="hl-sub"></small></div></div>
      <section class="hl-sec"><div class="hl-sec-b">
        ${edgeRow('a', 'In', '[')}${edgeRow('b', 'Out', ']')}
        <div class="hl-field"><span class="hl-flab">Length</span><span class="hl-fval" data-v="l">—</span></div>
        <label class="hl-notefield"><span class="hl-flab">Note</span><textarea class="hl-note" rows="2" placeholder="What you like here" aria-label="Note for this highlight"></textarea></label>
        <div class="hl-acts"><button class="hl-cta" type="button" data-a="playr" title="Play the range in a loop (P)"><span class="hl-cta-ic"></span><span class="hl-cta-l">Play range</span></button>
          <button class="hl-cta" type="button" data-a="clear" title="Clear the selection (Esc)">Clear</button><span class="hl-grow"></span>
          <button class="hl-cta" type="button" data-a="cancel" title="Put the range back as it was (Esc)">Cancel<kbd class="hl-kbd">Esc</kbd></button>
          <button class="hl-prim" type="button" data-a="done" title="Keep the new range (Enter)">Done<kbd class="hl-kbd">⏎</kbd></button>
          <button class="hl-prim" type="button" data-a="add" title="Add the selection to the list (Enter)">${IC.add(12)}Add highlight<kbd class="hl-kbd">⏎</kbd></button></div>
      </div></section>
      <section class="hl-sec hl-sec-list"><div class="hl-sec-h"><span class="hl-sec-ic">${IC.list}</span>Highlights<span class="hl-count">0</span><button class="hl-cta" type="button" data-a="reel" title="Play every highlight in list order, back to back">${IC.play(10)}<span class="hl-reel-l">Play all as a reel</span></button></div>
        <div class="hl-list"><p class="hl-empty"></p></div></section>`;
    $('.glm-side').append(panel);
    wire(); load(); drawFilms(); loadSprites();
  }

  // ── filmstrips: the engine's own frames, pre-rendered per source (strips.js) ──
  function loadSprites() {
    RV().sources().forEach(s => { const d = window.RV_STRIPS?.[s.k]; if (!d) return; const img = new Image(); img.onload = () => { sprites[s.k] = { img, ...d }; drawFilm(s.k); renderList(); }; img.src = d.strip; });
  }
  function drawFilm(k) {
    const c = films[k]; if (!c) return; const w = c.clientWidth, h = c.clientHeight, dpr = window.devicePixelRatio || 1; if (!w || !h) return;
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); const g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    const sp = sprites[k];
    if (!sp) { g.fillStyle = SRC(k).values?.background || '#2a2d2f'; g.fillRect(0, 0, w, h); return; }
    const tw = h * sp.tw / sp.th, n = Math.ceil(w / tw);
    for (let i = 0; i < n; i++) { const x = i * tw, f = clamp(Math.floor((x + tw / 2) / w * N), 0, N - 1), idx = Math.min(sp.n - 1, Math.floor(f / sp.step)); g.drawImage(sp.img, idx * sp.tw, 0, sp.tw, sp.th, x, 0, tw, h); }
    g.fillStyle = 'rgba(0,0,0,.35)'; for (let j = 1; j < n; j++) g.fillRect(Math.round(j * tw), 0, 1, h);
  }
  function drawFilms() { Object.keys(films).forEach(drawFilm); }

  // ── render ──
  const pos = (e, a, b) => { e.style.left = (a / N * 100) + '%'; e.style.width = ((b + 1 - a) / N * 100) + '%'; };
  let clips = [];
  function renderTimeline() {
    const k0 = cur();
    Object.keys(tracks).forEach(k => tracks[k].classList.toggle('hl-on', k === k0));
    while (clips.length < hls.length) { const c = el('div', 'hl-hc', `<button class="hl-hc-tag" type="button" title="Edit this highlight"><span class="hl-hc-n"></span><span class="hl-hc-star">${IC.star(9)}</span></button>`); c.querySelector('.hl-hc-tag').addEventListener('click', e => { e.stopPropagation(); startEdit(+c.dataset.i); }); clips.push(c); }
    hls.forEach((h, i) => {
      const c = clips[i]; c.dataset.i = i;
      if (edit && edit.h === h) { c.hidden = true; return; }
      if (c.parentNode !== lanes[h.k]) lanes[h.k].append(c);
      c.hidden = false; pos(c, h.a, h.b); c.classList.toggle('hl-must', !!h.must); c.classList.toggle('hl-playing', !!(reel && reel.i === i));
      c.querySelector('.hl-hc-n').textContent = '#' + (i + 1); c.title = '#' + (i + 1) + ' · f' + h.a + '–' + h.b + (h.note ? ' · ' + h.note : '');
    });
    for (let j = hls.length; j < clips.length; j++) clips[j].hidden = true;
    const r = active(), lane = lanes[k0];
    if (r && lane) {
      if (rng.parentNode !== lane) lane.append(rng); rng.className = 'hl-rng hl-on ' + (r.kind === 'edit' ? 'hl-ed' : 'hl-sel'); pos(rng, r.a, r.b);
      rng.querySelector('.hl-rng-lab').textContent = (r.kind === 'edit' ? '#' + (hls.indexOf(edit.h) + 1) + ' · ' : '') + (r.b - r.a + 1) + ' f · ' + ((r.b - r.a + 1) / FPS).toFixed(2) + ' s';
      rng.querySelector('.hl-hd-a').classList.toggle('hl-cur', edge === 'a'); rng.querySelector('.hl-hd-b').classList.toggle('hl-cur', edge === 'b');
    } else rng.className = 'hl-rng';
    if (!r && sel && sel.a != null && lane) { if (inm.parentNode !== lane) lane.append(inm); inm.style.left = (sel.a / N * 100) + '%'; inm.classList.add('hl-on'); inm.querySelector('b').textContent = 'in f' + sel.a; }
    else inm.classList.remove('hl-on');
  }
  function renderInspector() {
    const r = active(), mode = edit ? 'edit' : (r ? 'sel' : (sel ? 'in' : 'none')), s = SRC(cur()), multi = RV().sources().length > 1;
    panel.dataset.mode = mode;
    const on = (k) => (multi ? ' · ' + SRC(k).title : '');
    const [t, sub] = mode === 'edit' ? ['Highlight #' + (hls.indexOf(edit.h) + 1) + on(edit.h.k), 'Editing its range · drag the handles or nudge']
      : mode === 'sel' ? ['New selection' + on(cur()), 'Not added yet'] : mode === 'in' ? ['In at f' + sel.a + on(cur()), 'Now the out, or drag on the filmstrip'] : ['No range' + on(cur()), 'Drag on the filmstrip, or mark an in and an out'];
    panel.querySelector('.hl-title').textContent = t; panel.querySelector('.hl-sub').textContent = sub;
    const h = target();
    panel.querySelector('[data-v=a]').innerHTML = h ? ('f' + h.a + ' <small>' + s2(h.a) + ' s</small>') : (sel && sel.a != null ? ('f' + sel.a + ' <small>' + s2(sel.a) + ' s</small>') : '—');
    panel.querySelector('[data-v=b]').innerHTML = h ? ('f' + h.b + ' <small>' + s2(h.b + 1) + ' s</small>') : '—';
    panel.querySelector('[data-v=l]').innerHTML = h ? ((h.b - h.a + 1) + ' f <small>· ' + ((h.b - h.a + 1) / FPS).toFixed(2) + ' s</small>') : '—';
    panel.querySelectorAll('.hl-nb').forEach(b => { b.disabled = !h; });
    // the note box: the new range's note until Add, or the edited highlight's own note
    const noteBox = panel.querySelector('.hl-note');
    noteBox.closest('.hl-notefield').hidden = mode === 'none';
    if (document.activeElement !== noteBox) noteBox.value = mode === 'edit' ? edit.h.note || '' : draftNote;
    noteBox.placeholder = mode === 'edit' ? 'What you like here' : 'What you like here: it goes with the highlight when you add it';
    panel.querySelectorAll('.hl-edge').forEach(e => e.classList.toggle('hl-cur', !!h && e.dataset.e === edge));
    const A = a => panel.querySelector(`.hl-sec [data-a=${a}]`), T = a => tl.querySelector(`[data-a=${a}]`);
    A('add').hidden = mode === 'edit'; A('add').disabled = mode !== 'sel';
    A('done').hidden = A('cancel').hidden = mode !== 'edit';
    A('clear').hidden = !(mode === 'sel' || mode === 'in');
    const looping = pr?.kind === 'range';
    for (const [b, ic, l] of [[A('playr'), '.hl-cta-ic', '.hl-cta-l'], [T('play'), '.hl-tsb-ic', '.hl-tsb-l']]) {
      b.disabled = !r && !looping; b.classList.toggle('hl-on', looping); b.setAttribute('aria-pressed', String(looping));
      b.querySelector(ic).innerHTML = looping ? IC.pause(b === T('play') ? 14 : 10) : IC.play(b === T('play') ? 14 : 10);
      b.querySelector(l).textContent = looping ? 'Stop' : (b === T('play') ? 'Play' : 'Play range');
    }
    T('add').disabled = !(mode === 'sel' || mode === 'edit'); T('add').querySelector('.hl-tsb-l').textContent = mode === 'edit' ? 'Done' : 'Add';
    T('clear').disabled = !(mode === 'sel' || mode === 'in');
    tl.querySelector('.hl-tlhint').innerHTML = mode === 'edit'
      ? 'Editing #' + (hls.indexOf(edit.h) + 1) + ': drag a handle to trim or expand it'
      : 'Drag on the filmstrip to select · handles trim it · <kbd class="hl-kbd">Alt</kbd> no snap · click a <b>#</b> tag to edit a highlight';
  }
  function renderList() {
    const multi = RV().sources().length > 1, list = panel.querySelector('.hl-list'), empty = panel.querySelector('.hl-empty');
    empty.hidden = hls.length > 0;
    empty.innerHTML = multi ? 'Nothing picked yet. Play a source, press <b>I</b> where a moment you like starts and <b>O</b> where it ends, then <b>Enter</b>, or drag across the filmstrip. Take as many as you like from every source; they may overlap in time. The order here is the order of the new cut.'
      : 'Nothing picked yet. Press <b>I</b> where a moment you like starts and <b>O</b> where it ends, then <b>Enter</b>, or drag across the filmstrip. The order here is the order of the new cut.';
    panel.querySelector('.hl-count').textContent = hls.length;
    const reelB = panel.querySelector('[data-a=reel]'); reelB.disabled = !hls.length; reelB.classList.toggle('hl-on', !!reel);
    reelB.querySelector('.hl-reel-l').textContent = reel ? 'Stop reel' : 'Play all as a reel';
    let items = [...list.querySelectorAll('.hl-it')];
    while (items.length < hls.length) { const it = item(); list.append(it); items.push(it); }
    hls.forEach((h, i) => {
      const it = items[i], s = SRC(h.k); it.dataset.i = i; it.hidden = false;
      it.querySelector('.hl-dot').style.background = s.col; it.querySelector('.hl-it-n').textContent = '#' + (i + 1);
      it.querySelector('.hl-it-src').textContent = multi ? s.title : (RV().title || 'Make it move');
      it.querySelector('.hl-it-len').textContent = ((h.b - h.a + 1) / FPS).toFixed(2) + ' s';
      it.querySelector('.hl-it-r').textContent = 'f' + h.a + '–' + h.b + ' · ' + s2(h.a) + '–' + s2(h.b + 1) + ' s · ' + (h.b - h.a + 1) + ' f';
      const th = it.querySelector('.hl-it-th'), sp = window.RV_STRIPS?.[h.k];
      if (sp) { const idx = Math.min(sp.n - 1, Math.floor(((h.a + h.b) / 2) / sp.step)), tw = Math.round(36 * (sp.tw || 16) / (sp.th || 9)); th.style.width = tw + 'px'; th.style.backgroundImage = `url("${sp.strip}")`; th.style.backgroundSize = (sp.n * tw) + 'px 36px'; th.style.backgroundPosition = (-idx * tw) + 'px 0'; }
      else th.style.background = s.values?.background || '#2a2d2f';
      const n = it.querySelector('.hl-it-note'); if (document.activeElement !== n) n.value = h.note || '';
      const star = it.querySelector('.hl-it-star'); star.setAttribute('aria-pressed', String(h.must)); star.title = h.must ? 'Must-have (on)' : 'Must-have';
      it.classList.toggle('hl-must', h.must); it.classList.toggle('hl-edit', !!(edit && edit.h === h)); it.classList.toggle('hl-playing', !!(reel && reel.i === i));
      const pb = it.querySelector('.hl-it-play'), looping = pr?.kind === 'item' && pr.h === h;
      pb.classList.toggle('hl-on', looping); pb.setAttribute('aria-pressed', String(looping));
      pb.title = looping ? 'Stop' : 'Play this highlight in a loop'; pb.setAttribute('aria-label', pb.title);
      if (pb.dataset.on !== String(looping)) { pb.dataset.on = String(looping); pb.innerHTML = looping ? IC.pause(11) : IC.play(11); }
      it.querySelector('.hl-it-up').disabled = i === 0; it.querySelector('.hl-it-dn').disabled = i === hls.length - 1;
    });
    for (let j = hls.length; j < items.length; j++) items[j].hidden = true;
    const cnt = {}; hls.forEach(h => { cnt[h.k] = (cnt[h.k] || 0) + 1; });
    tl.querySelectorAll('.hl-track').forEach(t => { const e = t.querySelector('.hl-lab-n'), n = cnt[t.dataset.k] || 0; e.textContent = n; e.classList.toggle('hl-has', n > 0); });
    RV().reel(reel ? 'Reel ' + (reel.i + 1) + ' / ' + hls.length + ' · #' + (reel.i + 1) : '');
  }
  function item() {
    const it = el('div', 'hl-it', `<button class="hl-it-th" type="button" title="Show it on the timeline"></button><div class="hl-it-b"><div class="hl-it-h"><i class="hl-dot"></i><b class="hl-it-n"></b><span class="hl-it-src"></span><span class="hl-it-must">${IC.star(9)}must</span><span class="hl-it-len"></span></div><div class="hl-it-r"></div><div class="hl-it-row"><input class="hl-it-note" type="text" placeholder="What you like here" aria-label="Note: what you like here"><span class="hl-it-a"><button class="hl-ib hl-it-play" type="button" title="Play this highlight in a loop" aria-label="Play this highlight in a loop">${IC.play(11)}</button><button class="hl-ib hl-it-edit" type="button" title="Edit its range: trim or expand" aria-label="Edit range">${IC.edit}</button><button class="hl-ib hl-it-star" type="button" title="Must-have" aria-label="Must-have" aria-pressed="false">${IC.star(13)}</button><button class="hl-ib hl-it-up" type="button" title="Move up" aria-label="Move up">${IC.up}</button><button class="hl-ib hl-it-dn" type="button" title="Move down" aria-label="Move down">${IC.down}</button><button class="hl-ib hl-it-del" type="button" title="Remove" aria-label="Remove">${IC.del}</button></span></div></div>`);
    const idx = () => +it.dataset.i, H = () => hls[idx()];
    // a highlight's ▶ plays its range in a loop (as Play range does); pressed again, it stops
    it.querySelector('.hl-it-play').onclick = () => {
      const h = H(); if (!h) return; if (reel) stopReel();
      if (pr?.kind === 'item' && pr.h === h) { pr = null; pauseAll(); renderAll(); return; }
      if (edit && edit.h !== h) doneEdit(true);
      playRange({ kind: 'item', h, k: h.k, loop: true, get: () => [h.a, h.b] });
    };
    it.querySelector('.hl-it-edit').onclick = () => { const i = idx(); if (edit && edit.h === hls[i]) doneEdit(); else startEdit(i); };
    it.querySelector('.hl-it-star').onclick = () => { const h = H(); if (!h) return; h.must = !h.must; store(); renderAll(); };
    it.querySelector('.hl-it-del').onclick = () => { const i = idx(), h = hls[i]; if (!h) return; if (reel) stopReel(); if (edit && edit.h === h) edit = null; hls.splice(i, 1); store(); renderAll(); toast('Removed #' + (i + 1)); };
    it.querySelector('.hl-it-up').onclick = () => { const i = idx(); if (i > 0 && !reel) { [hls[i - 1], hls[i]] = [hls[i], hls[i - 1]]; store(); renderAll(); } };
    it.querySelector('.hl-it-dn').onclick = () => { const i = idx(); if (i < hls.length - 1 && !reel) { [hls[i + 1], hls[i]] = [hls[i], hls[i + 1]]; store(); renderAll(); } };
    const note = it.querySelector('.hl-it-note');
    note.oninput = () => { const h = H(); if (!h) return; h.note = note.value; store(); };
    note.onkeydown = e => { if (e.key === 'Escape' || e.key === 'Enter') { note.blur(); e.stopPropagation(); } };
    it.querySelector('.hl-it-th').onclick = () => { const h = H(); if (!h) return; if (reel) stopReel(); if (cur() !== h.k && !pick(h.k)) return; pauseAll(); pr = null; seek(h.a); renderAll(); };
    return it;
  }
  function renderAll() { if (!tl) return; renderTimeline(); renderInspector(); renderList(); paintHead(shown); }

  // ── pointer: ruler scrubs; the current source's filmstrip selects; another source's lane switches to it ──
  function laneX(e) { const r = ruler.getBoundingClientRect(); return { x: clamp(e.clientX - r.left, 0, r.width), w: r.width }; }
  const fAt = e => { const p = laneX(e); return clamp(Math.floor(p.x / p.w * N), 0, N - 1); };
  const bAt = e => { const p = laneX(e); return clamp(Math.round(p.x / p.w * N), 0, N); };
  function showSnap(c) { if (c == null) { snapg.classList.remove('hl-on'); return; } const lane = lanes[cur()]; if (snapg.parentNode !== lane) lane.append(snapg); snapg.style.left = (c / N * 100) + '%'; snapg.classList.add('hl-on'); }
  function wire() {
    ruler.addEventListener('pointerdown', e => { if (e.button !== 0 || e.target.closest('.mn-flag, .mn-rh')) return; /* a note flag opens its note; an edge drags */ if (reel) stopReel(); pauseAll(); pr = null; drag = { kind: 'scrub' }; ruler.setPointerCapture(e.pointerId); seek(fAt(e)); renderAll(); });
    ruler.addEventListener('pointermove', e => { if (drag?.kind === 'scrub') seek(fAt(e)); });
    ruler.addEventListener('pointerup', () => { drag = null; });
    const partsLane = tl.querySelector('.hl-parts');
    if (partsLane) {
      partsLane.addEventListener('pointerdown', e => { if (e.button !== 0) return; if (reel) stopReel(); pauseAll(); pr = null; drag = { kind: 'scrub' }; partsLane.setPointerCapture(e.pointerId); seek(fAt(e)); renderAll(); });
      partsLane.addEventListener('pointermove', e => { if (drag?.kind === 'scrub') seek(fAt(e)); });
      partsLane.addEventListener('pointerup', () => { drag = null; });
    }
    Object.entries(lanes).forEach(([k, lane]) => {
      lane.addEventListener('pointerdown', e => {
        if (e.button !== 0 || e.target.closest('.hl-hd') || e.target.closest('.hl-hc-tag')) return;
        if (reel) stopReel();
        if (k !== cur()) { const hc = e.target.closest('.hl-hc'); if (hc) { startEdit(+hc.dataset.i); return; } if (pick(k)) { pauseAll(); seek(fAt(e)); } return; }
        pauseAll(); pr = null; lane.setPointerCapture(e.pointerId);
        if (edit || RV().mode() !== 'highlight') { drag = { kind: 'scrub' }; seek(fAt(e)); renderAll(); return; }
        const s0 = snapB(bAt(e), e.altKey); drag = { kind: 'sel', b0: s0.b, b1: s0.b }; seek(fAt(e));
      });
      lane.addEventListener('pointermove', e => {
        if (!drag || k !== cur()) return;
        if (drag.kind === 'scrub') { seek(fAt(e)); return; }
        if (drag.kind === 'sel') {
          const s = snapB(bAt(e), e.altKey); drag.b1 = s.b; showSnap(s.c);
          const a = Math.min(drag.b0, drag.b1), b = Math.max(drag.b0, drag.b1) - 1;
          if (b - a + 1 >= 4) { sel = { a, b }; edge = drag.b1 > drag.b0 ? 'b' : 'a'; renderTimeline(); renderInspector(); }
          seek(drag.b1 > drag.b0 ? Math.min(N - 1, drag.b1 - 1) : drag.b1);
        }
      });
      lane.addEventListener('pointerup', () => { if (drag?.kind === 'sel') renderAll(); drag = null; showSnap(null); });
      lane.addEventListener('pointercancel', () => { drag = null; showSnap(null); });
    });
    [['a', rng.querySelector('.hl-hd-a')], ['b', rng.querySelector('.hl-hd-b')]].forEach(([e0, h]) => {
      h.addEventListener('pointerdown', e => { if (e.button !== 0) return; e.stopPropagation(); e.preventDefault(); if (reel) stopReel(); if (pr?.kind !== 'range') { pauseAll(); pr = null; } edge = e0; drag = { kind: 'handle', e: e0 }; h.setPointerCapture(e.pointerId); renderAll(); });
      h.addEventListener('pointermove', e => {
        if (drag?.kind !== 'handle') return; const t = target(); if (!t) return; const s = snapB(bAt(e), e.altKey); showSnap(s.c);
        if (e0 === 'a') setEdge('a', s.b); else setEdge('b', s.b - 1);
        if (pr?.kind !== 'range') seek(e0 === 'a' ? t.a : t.b);
        renderTimeline(); renderInspector(); if (edit) renderList();
      });
      h.addEventListener('pointerup', () => { drag = null; showSnap(null); renderAll(); });
      h.addEventListener('pointercancel', () => { drag = null; showSnap(null); });
    });
    const T = a => tl.querySelector(`[data-a=${a}]`), A = a => panel.querySelector(`[data-a=${a}]`);
    T('in').onclick = markIn; T('out').onclick = markOut; T('add').onclick = add; T('clear').onclick = clearSel; T('play').onclick = playActive;
    T('snap').onclick = () => { snapOn = !snapOn; T('snap').classList.toggle('hl-on', snapOn); T('snap').setAttribute('aria-pressed', String(snapOn)); toast(snapOn ? `Snapping to ${CFG.beats ? 'cuts and beats' : 'keyframes'} (Alt: free)` : 'Snapping off (Alt: snap)'); };
    A('playr').onclick = playActive; A('clear').onclick = clearSel; A('add').onclick = add; A('done').onclick = () => doneEdit(); A('cancel').onclick = cancelEdit;
    A('reel').onclick = () => { if (reel) stopReel(); else startReel(); };
    const noteBox = panel.querySelector('.hl-note');
    noteBox.oninput = () => { if (edit) { edit.h.note = noteBox.value; store(); renderList(); } else draftNote = noteBox.value; };
    noteBox.onkeydown = e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); noteBox.blur(); }
      else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.stopPropagation(); noteBox.blur(); add(); }
    };
    panel.querySelectorAll('.hl-nb').forEach(b => b.onclick = () => nudge(b.dataset.e, +b.dataset.d));
    panel.querySelectorAll('.hl-tph').forEach(b => b.onclick = () => toPlayhead(b.dataset.e));
    panel.querySelectorAll('.hl-edgepick').forEach(b => b.onclick = () => { edge = b.dataset.e; const h = target(); if (h && pr?.kind !== 'range') { pauseAll(); pr = null; seek(edge === 'a' ? h.a : h.b); } renderAll(); });
    tl.querySelectorAll('.hl-track .hl-lab').forEach(l => l.addEventListener('click', () => pick(l.closest('.hl-track').dataset.k)));
    new ResizeObserver(drawFilms).observe(ruler);
  }
  document.addEventListener('keydown', e => {
    if (!isOpen || RV()?.mode() !== 'highlight') return;
    const tg = e.target; if (tg.closest?.('input,textarea,select,[contenteditable]') || e.metaKey || e.ctrlKey) return;
    if (!document.querySelector('.rv-pop')?.hidden) return;
    const k = e.key, c = e.code; let done = true;
    if (k === ' ') playPause();
    else if (k === 'ArrowLeft') step(e.shiftKey ? -10 : -1); else if (k === 'ArrowRight') step(e.shiftKey ? 10 : 1);
    else if (k === 'Home') step(-N); else if (k === 'End') step(N);
    else if (k === 'i' || k === 'I') markIn(); else if (k === 'o' || k === 'O') markOut();
    else if (k === 'Enter') { if (tg.tagName === 'BUTTON') done = false; else add(); }
    else if (k === 'Escape') { if (reel) stopReel(); else if (edit) cancelEdit(); else if (sel) clearSel(); else if (pr) { pr = null; pauseAll(); renderAll(); } else done = false; }
    else if (k === '[') { if (target()) { edge = 'a'; renderAll(); } } else if (k === ']') { if (target()) { edge = 'b'; renderAll(); } }
    else if (c === 'Comma' || k === ',' || k === '<') nudge(edge, e.shiftKey ? -10 : -1);
    else if (c === 'Period' || k === '.' || k === '>') nudge(edge, e.shiftKey ? 10 : 1);
    else if (k === 'p' || k === 'P') playActive();
    else done = false;
    if (done) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
  document.addEventListener('keyup', e => { if (isOpen && e.key === ' ' && e.target?.tagName === 'BUTTON') e.preventDefault(); });

  function open() { if (!tl) return; isOpen = true; shown = fr(); requestAnimationFrame(() => { drawFilms(); renderAll(); }); }
  function close() { if (!isOpen) return; if (reel) stopReel(); if (edit) doneEdit(true); pr = null; isOpen = false; RV()?.reel(''); }
  function install() {
    if (!api()?.ready || !RV()?.ready() || !$('.glm-tlwrap') || !$('.glm-side')) { setTimeout(install, 100); return; }
    build(); renderAll(); requestAnimationFrame(tick);
    RV().onChange(() => { if (!tl) return; const was = tlOn; tlOn = ['notes', 'highlight'].includes(RV().mode()); if (tlOn && !was) shown = fr(); renderAll(); requestAnimationFrame(drawFilms); });
    // a card that opens in Highlight (or Notes): the timeline is on from the start
    tlOn = ['notes', 'highlight'].includes(RV().mode()); if (RV().mode() === 'highlight') open();
    RV().changed();
  }
  window.addEventListener('rv:remount', () => { if (!tl) return; $('.glm-tlwrap').append(tl); $('.glm-side').append(panel); requestAnimationFrame(() => { drawFilms(); renderAll(); }); });
  window.LabHighlight = { open, close, pick: k => pick(k), list: () => hls.map(clean), editing: () => !!edit, finishEdit: () => doneEdit(true), state: () => ({ cur: cur(), sel, edit: edit && { i: hls.indexOf(edit.h), a: edit.h.a, b: edit.h.b }, edge, looping: pr?.kind === 'range', itemLoop: pr?.kind === 'item' ? hls.indexOf(pr.h) : -1, reel: reel && reel.i, frame: shown, n: hls.length }) };
  install();
}
