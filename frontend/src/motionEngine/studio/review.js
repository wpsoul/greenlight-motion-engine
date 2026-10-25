/* global GL_LAB_PROJECT, LabNotes */   // window globals the studio parts share (studio/index.js)
/* Review controller: one card, three modes over one or more sources.
   Edit = the inspector · Notes = drawings and words for the agent · Highlight = parts picked from the sources.
   Owns the top switch (Edit · Notes · Highlight tabs centred over the preview: the owner's pick, look C with Edit),
   the current source, the preview chip and "Save for agent".
   A card outside the lab (a board card over rendered videos) sets window.RV_CONFIG before this file: { title, modes,
   start, storeKey, save(job) } — its own film name, the modes it offers, the one it opens in, its storage, and where
   Save for agent writes (job: { payload, notes, textFor(paths) } → { ok, where } or throws). A card whose sources
   differ in kind adds: canMode(mode, source) (Edit only on a source with a project), onSource(prev, next, t) (open
   the next source's project; may be async), extra() → { payload, lines } (its own part of the review: the editor
   tweaks per source, with their lines for the agent's text). A host that sends somewhere else names the button:
   saveLabel / saveTitle / savedText (a chat: "Send to Claude"); with no save(), copyNote heads the text to copy. */
export function install(STUDIO) {
  const $ = s => document.querySelector(s), api = () => window.GreenLightMotion?.page;
  const CFG = window.RV_CONFIG || {};
  const ALL = window.RV_SOURCES || [{k:'A',title:'A',sub:'',col:'#a78bfa',values:{},layers:{}}];
  const MODES = CFG.modes || ['edit', 'notes', 'highlight'], TITLE = CFG.title || 'Make it move';
  const read = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
  const write = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
  const hash = new URLSearchParams(location.hash.slice(1));
  const count = CFG.storeKey ? ALL.length : +(hash.get('sources') || '3') === 1 ? 1 : 3;   // the lab's one-film view: #sources=1
  const sources = count === 1 ? ALL.slice(0, 1) : ALL.slice();
  const storeKey = CFG.storeKey || 'rv-lab-' + count;
  let mode = MODES.includes(CFG.start) ? CFG.start : MODES[0], cur = sources[0].k, ready = false, base = null, savedSig = read(storeKey + '-saved', ''), saveState = 'none', savedAt = '';
  const listeners = new Set();
  const svg = p => `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
  const ic = {
    edit: svg('<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="10" cy="18" r="2"/>'),
    notes: svg('<path d="m4 16-1 5 5-1L20 8l-4-4zM14 6l4 4"/>'),
    highlight: svg('<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.12 15.88M14.47 14.48 20 20M8.12 8.12 12 12"/>'),
    save: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/>'),
    copy: svg('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
    play: '<svg width="10" height="10" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4 19 12 6 20z" fill="currentColor"/></svg>'
  };
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const srcOf = k => sources.find(s => s.k === k) || sources[0];
  const emit = () => listeners.forEach(fn => { try { fn(); } catch (e) { console.error(e); } });

  // ── sources: each is the same project with its own template values and layer colours ──
  function itemOf(id) { for (const ch of GL_LAB_PROJECT.channels) for (const it of ch.items) if (it.id === id) return it; return {}; }
  function layerPaths() { const m = {}; ALL.forEach(s => Object.entries(s.layers || {}).forEach(([id, o]) => Object.keys(o).forEach(p => (m[id] ||= new Set()).add(p)))); return m; }
  function apply(src) {
    const now = api().values(), v = { ...base.values, ...src.values };
    Object.entries(v).forEach(([key, val]) => { if (now[key] !== val) api().setValue(key, val); });
    for (const [id, paths] of Object.entries(layerPaths())) for (const p of paths) api().setLayerValue(id, p, src.layers?.[id]?.[p] ?? base.layers[id][p]);
  }
  function setSource(k) {
    if (!ready || k === cur || !sources.some(s => s.k === k)) return k === cur;
    // a drawing or range still open in Notes is kept in the new note first, then the source switches
    if (window.LabNotes?.hasWork?.()) { window.LabNotes.keepWork().then(ok => { if (ok) { setSource(k); window.LabSide?.toast('Your drawing is kept in the new note'); } }); return false; }
    const t = api().state().playhead;
    srcOf(cur).values = { ...api().values() };
    api().pause(); const prev = cur; cur = k;
    const done = () => { write(storeKey + '-src', k); renderSwitch(); renderSources(); emit(); };
    // a card's sources may be different projects: it opens the next one itself (the page is rebuilt meanwhile)
    if (CFG.onSource) { Promise.resolve(CFG.onSource(prev, k, t)).catch(e => { console.error(e); window.LabSide?.toast(`Could not open ${srcOf(k).title}: ${e.message}`); }).finally(done); return true; }
    apply(srcOf(k)); api().seek(t); done(); return true;
  }

  // ── modes ──
  const allowed = (m, k = cur) => !CFG.canMode || CFG.canMode(m, k);
  function setMode(m) {
    if (m === mode || !ready || !MODES.includes(m)) return;
    if (!allowed(m)) { window.LabSide?.toast(CFG.cantMode?.(m, cur) || 'Not on this source'); return; }
    if (mode === 'notes' && window.LabNotes && LabNotes.close() === false) return;
    if (mode === 'highlight') window.LabHighlight?.close();
    api()?.pause();
    mode = m;
    document.body.classList.remove('rv-mode-edit', 'rv-mode-notes', 'rv-mode-highlight'); document.body.classList.add('rv-mode-' + m);
    if (m === 'notes') window.LabNotes?.open();
    if (m === 'highlight') { window.LabHighlight?.open(); if (sources.length > 1) window.LabSide?.tab('sources', { expand: false }); }
    if (m === 'edit') { const back = $('.glm-side .glm-icon[aria-label="Back to Options"]'); if (back) back.click(); }
    renderSwitch(); emit();
  }
  // Edit is a tab of its own, so a tab always shows its mode: pressing the open one keeps it.
  function press(m) { setMode(m); }

  // ── top bar ──
  let sw, state, save, pop, chip, reelBadge;
  function buildTop() {
    const top = $('.glm-top');
    sw = el('div', 'rv-switch'); sw.setAttribute('role', 'group'); sw.setAttribute('aria-label', 'Mode');
    for (const [m, label] of [['edit', 'Edit'], ['notes', 'Notes'], ['highlight', 'Highlight']].filter(([m]) => MODES.includes(m))) {
      const b = el('button', 'rv-sw'); b.type = 'button'; b.dataset.mode = m; b.innerHTML = ic[m]; b.append(el('span', 'rv-sw-l', label));
      if (m !== 'edit') b.append(el('b', 'rv-count'));
      b.title = m === 'edit' ? 'Edit the film: layers and options' : m === 'notes' ? 'Draw on frames and write notes for the agent (N)' : 'Pick the parts you like from the sources for a new cut';
      b.dataset.tip = b.title; b.onclick = () => press(m); sw.append(b);
    }
    state = el('span', 'rv-state'); state.setAttribute('aria-live', 'polite'); state.append(el('i'), el('span'));
    save = el('button', 'rv-save'); save.type = 'button'; save.innerHTML = ic.save; save.append(el('span', '', CFG.saveLabel || 'Save for agent'));
    save.title = CFG.saveTitle || 'Write your notes and highlights to the note the agent reads'; save.onclick = saveForAgent;
    top.append(sw, state, save);
    pop = el('div', 'rv-pop'); pop.hidden = true; pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-label', 'Saved for the agent');
    pop.innerHTML = `<p class="rv-pop-msg"><b>Saved for the agent.</b> On a board this text goes into the REVIEW note your agent reads, with the note drawings beside it. In this lab, copy it from here.</p><textarea readonly aria-label="Text for the agent"></textarea><div class="rv-pop-row"><button type="button" class="rv-cta" data-a="copy">${ic.copy}Copy</button><button type="button" class="rv-cta" data-a="close">Close</button></div>`;
    pop.querySelector('[data-a=copy]').onclick = () => { const ta = pop.querySelector('textarea'); ta.focus(); ta.select(); let ok = false; try { ok = document.execCommand('copy'); } catch {} if (!ok) navigator.clipboard?.writeText(ta.value).catch(() => {}); window.LabSide?.toast('Copied'); };
    pop.querySelector('[data-a=close]').onclick = () => { pop.hidden = true; };
    document.body.append(pop);
    // Render and its pane live in Edit: leave a review mode first.
    document.addEventListener('click', e => { if (e.target.closest('.glm-top .glm-xbtn') && mode !== 'edit') setMode('edit'); }, true);
    chip = el('span', 'rv-chip'); chip.append(el('i', 'rv-dot'), el('b')); reelBadge = el('span', 'rv-reel'); reelBadge.innerHTML = ic.play; reelBadge.append(el('span'));
    $('.glm-view').append(chip, reelBadge);
    new ResizeObserver(placeChip).observe($('.glm-view'));
  }
  // the page rebuilt (lab.js rebuild: a layer added, duplicated or deleted): the same parts go back in
  window.addEventListener('rv:remount', () => { $('.glm-top').append(sw, state, save); $('.glm-view').append(chip, reelBadge); new ResizeObserver(placeChip).observe($('.glm-view')); renderSwitch(); changed(); });
  function placeChip() {
    const f = $('.glm-frame'), v = $('.glm-view'); if (!f || !v) return;
    const fr = f.getBoundingClientRect(), vr = v.getBoundingClientRect();
    chip.style.left = reelBadge.style.left = (fr.left - vr.left + 10) + 'px'; chip.style.top = (fr.top - vr.top + 10) + 'px'; reelBadge.style.top = (fr.top - vr.top + 40) + 'px';
  }
  function renderSwitch() {
    if (!sw) return;
    sw.querySelectorAll('.rv-sw').forEach(b => { b.setAttribute('aria-pressed', String(b.dataset.mode === mode)); const ok = allowed(b.dataset.mode); b.classList.toggle('rv-off', !ok); b.setAttribute('aria-disabled', String(!ok)); b.title = ok ? b.dataset.tip : CFG.cantMode?.(b.dataset.mode, cur) || b.dataset.tip; });
    const n = window.LabNotes?.state().notes.length || 0, h = window.LabHighlight?.list().length || 0;
    const cn = sw.querySelector('[data-mode=notes] .rv-count'), ch = sw.querySelector('[data-mode=highlight] .rv-count');
    if (cn) cn.textContent = n || ''; if (ch) ch.textContent = h || '';
    // an agent reply you haven't seen: the amber pip of the app's note chips, on the Notes tab
    sw.querySelector('[data-mode=notes]')?.classList.toggle('rv-replied', !!window.LabNotes?.state().notes.some(x => x.unread));
    const s = srcOf(cur); chip.hidden = sources.length < 2; chip.querySelector('i').style.background = s.col; chip.querySelector('b').textContent = s.title;
    placeChip();
  }

  // ── left: the Sources tab (only with more than one source) ──
  function renderSources() {
    const list = $('#source-list'); if (!list) return;
    const hl = window.LabHighlight?.list() || [], notes = window.LabNotes?.state().notes || [];
    if (!list.children.length) sources.forEach((s, i) => {
      const b = el('button', 'rv-src'); b.type = 'button'; b.dataset.k = s.k; b.title = `Show this source (key ${i + 1})`;
      const po = el('span', 'rv-src-po'); const strip = window.RV_STRIPS?.[s.k]; if (strip?.poster) po.style.backgroundImage = `url("${strip.poster}")`; else po.style.background = s.values?.background || base.values.background || '#222';
      const tx = el('span', 'rv-src-tx'); const t = el('b'); const dot = el('i', 'rv-dot'); dot.style.background = s.col; t.append(dot, document.createTextNode(s.title));
      tx.append(t, el('small', '', s.sub), el('em', 'rv-src-n')); const key = el('kbd', 'rv-kbd', String(i + 1));
      b.append(po, tx, key); b.onclick = () => { if (mode === 'highlight') window.LabHighlight?.pick(s.k); else setSource(s.k); }; list.append(b);
    });
    list.querySelectorAll('.rv-src').forEach(b => {
      const on = b.dataset.k === cur; b.classList.toggle('rv-on', on); b.setAttribute('aria-pressed', String(on));
      const nh = hl.filter(h => h.k === b.dataset.k).length, nn = notes.filter(n => n.shots.some(s => (s.src || sources[0].k) === b.dataset.k)).length;
      const parts = []; if (nh) parts.push(nh + (nh === 1 ? ' highlight' : ' highlights')); if (nn) parts.push(nn + (nn === 1 ? ' note' : ' notes'));
      const em = b.querySelector('.rv-src-n'); em.textContent = parts.join(' · ') || 'nothing picked'; em.classList.toggle('rv-has', parts.length > 0);
    });
  }

  // ── save for agent ──
  const fmt = t => `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, '0')}`;
  function payload() {
    const notes = (window.LabNotes?.state().notes || []).map(n => ({ n: n.n, id: n.id, text: n.text, thread: (n.thread || []).map(c => ({ by: c.by, text: c.text, at: c.at })), shots: n.shots.map(s => ({ source: s.src || sources[0].k, kind: s.kind, t: +s.t.toFixed(3), end: s.end == null ? null : +s.end.toFixed(3), marks: s.marks.length })) }));
    const highlights = (window.LabHighlight?.list() || []).map(h => ({ source: h.k, a: h.a, b: h.b, note: h.note, must: h.must }));
    const extra = CFG.extra?.()?.payload;
    return extra ? { notes, highlights, ...extra } : { notes, highlights };
  }
  const hasExtra = p => Object.keys(p).some(k => k !== 'notes' && k !== 'highlights' && p[k] && (Array.isArray(p[k]) ? p[k].length : Object.keys(p[k]).length));
  function signature() { const p = payload(); return p.notes.length || p.highlights.length || hasExtra(p) ? JSON.stringify(p) : ''; }
  function agentText(paths) {
    const p = payload(), fps = api().state().fps, title = srcOf => (sources.find(s => s.k === srcOf) || {}).title || srcOf;
    const L = [`REVIEW · ${TITLE} · saved ${new Date().toLocaleString()}`, `Sources: ${sources.map(s => s.title).join(', ')} · ${api().duration.toFixed(2)} s · ${Math.round(api().duration * fps)} frames at ${fps} fps on one shared timeline`, ''];
    L.push(`NOTES (${p.notes.length})`);
    p.notes.forEach(n => { L.push(`#${n.n} · ${n.text ? '"' + n.text + '"' : 'drawings only'}`); n.thread.forEach(c => L.push(`  ${c.by === 'agent' ? 'Agent' : 'You'}: "${c.text}"`)); n.shots.forEach((s, i) => L.push(`  - ${title(s.source)} · ${s.kind === 'range' ? 'range ' + fmt(s.t) + '–' + fmt(s.end) : 'frame ' + fmt(s.t)} · ${s.marks} marks · ${paths?.[n.n + '-' + (i + 1)] || `note-${n.n}-${i + 1}.png`}`)); });
    const extraLines = CFG.extra?.()?.lines; if (extraLines?.length) L.push('', ...extraLines);
    L.push('', `HIGHLIGHTS (${p.highlights.length}, in the order of the new cut; frames inclusive)`);
    p.highlights.forEach((h, i) => L.push(`#${i + 1}${h.must ? ' ★ must' : ''} · ${title(h.source)} · f${h.a}–${h.b} (${(h.a / fps).toFixed(2)}–${((h.b + 1) / fps).toFixed(2)} s, ${((h.b - h.a + 1) / fps).toFixed(2)} s)${h.note ? ' · "' + h.note + '"' : ''}`));
    if (CFG.agentHelp) L.push('', ...CFG.agentHelp);
    L.push('', 'JSON ' + JSON.stringify(p));
    return L.join('\n');
  }
  function hhmm() { const d = new Date(); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }
  function showText(html, text) { pop.querySelector('.rv-pop-msg').innerHTML = html; pop.querySelector('textarea').value = text; pop.hidden = false; }
  let saving = false, saveError = '';
  async function saveForAgent() {
    if (saving) return;
    if (window.LabHighlight?.editing()) window.LabHighlight.finishEdit();
    const sig = signature(); if (!sig) { window.LabSide?.toast(MODES.includes('edit') ? 'Add a note, a highlight or a change first' : 'Add a note or a highlight first'); return; }
    if (!CFG.save) {
      showText(CFG.copyNote || '<b>Saved for the agent.</b> On a board this text goes into the REVIEW note your agent reads, with the note drawings beside it. In this lab, copy it from here.', agentText());
      savedSig = sig; savedAt = hhmm(); write(storeKey + '-saved', sig); changed(); return;
    }
    saving = true; saveError = ''; changed();
    try {
      const r = await CFG.save({ payload: payload(), notes: window.LabNotes?.state().notes || [], textFor: agentText });
      savedSig = sig; savedAt = hhmm(); write(storeKey + '-saved', sig);
      window.LabSide?.toast((CFG.savedText || 'Saved for the agent') + (r?.where ? ' · ' + r.where : ''));
    } catch (e) {
      saveError = e.message || String(e);
      showText(`<b>Could not write the note.</b> ${saveError.replace(/</g, '&lt;')} Copy the text below and give it to your agent.`, agentText());
    } finally { saving = false; changed(); }
  }
  const STATE = { none: 'nothing to send yet', unsaved: 'not saved yet', changed: 'changed · not saved', saved: 'saved', saving: 'saving…', failed: 'not saved · try again' };
  function changed() {
    if (!state) return;
    const sig = signature(), p = sig ? JSON.parse(sig) : { notes: [], highlights: [] };
    const nTweaks = CFG.extra?.()?.count || 0;
    saveState = saving ? 'saving' : !sig ? 'none' : sig === savedSig ? 'saved' : saveError ? 'failed' : savedSig ? 'changed' : 'unsaved';
    state.dataset.s = saveState;
    const counts = [p.notes.length && p.notes.length + (p.notes.length === 1 ? ' note' : ' notes'), p.highlights.length && p.highlights.length + (p.highlights.length === 1 ? ' highlight' : ' highlights'), nTweaks && nTweaks + (nTweaks === 1 ? ' change' : ' changes')].filter(Boolean).join(' · ');
    state.querySelector('span').textContent = STATE[saveState] + (saveState === 'saved' ? ` ✓ ${savedAt ? savedAt + ' · ' : ''}${counts}` : '');
    save.disabled = !sig || saving;
    renderSwitch(); renderSources();
  }

  // ── lab only: a stand-in for the agent's reply (on a board the agent writes it): RV.simulateReply() ──
  function simulateReply() {
    const notes = window.LabNotes?.state().notes || [];
    const note = [...notes].reverse().find(n => (n.thread || []).slice(-1)[0]?.by !== 'agent') || notes[notes.length - 1];
    if (!note) return false;
    const shot = note.shots[0], where = shot ? `${(sources.find(s => s.k === (shot.src || sources[0].k)) || {}).title || ''} at ${fmt(shot.t)}` : 'the film';
    return window.LabNotes.reply(note.n, `Done: I changed it in ${where}. Have a look; if it's right, press Solved.`);
  }

  // ── keys every mode shares ──
  document.addEventListener('keydown', e => {
    if (!ready || e.target.closest?.('input,textarea,select,[contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (!pop.hidden && e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); pop.hidden = true; return; }
    if ((e.key === 'n' || e.key === 'N') && mode !== 'notes') { e.preventDefault(); e.stopImmediatePropagation(); setMode('notes'); return; }
    if (/^[1-9]$/.test(e.key) && sources.length > 1) {
      const s = sources[+e.key - 1]; if (!s) return; e.preventDefault(); e.stopImmediatePropagation();
      if (mode === 'highlight') window.LabHighlight?.pick(s.k); else setSource(s.k);
    }
  }, true);

  function start() {
    if (!api()?.ready || !$('.glm-top') || !$('.glm-view')) { setTimeout(start, 100); return; }
    const v = api().values(), layers = {};
    for (const [id, paths] of Object.entries(layerPaths())) { layers[id] = {}; const it = itemOf(id); for (const p of paths) layers[id][p] = it[p]; }
    base = { values: { ...v }, layers };
    ready = true;
    buildTop();
    document.querySelector('[data-tab=sources]').hidden = sources.length < 2;
    document.querySelector('.rv-multi').hidden = sources.length < 2;
    $('#keys-last').textContent = sources.length;
    $('#project-sources').textContent = sources.length === 1 ? 'One film' : `${sources.length} variants`;
    const k = read(storeKey + '-src', sources[0].k);
    if (k !== cur && sources.some(s => s.k === k)) { cur = k; apply(srcOf(k)); }
    document.body.classList.remove('rv-mode-edit', 'rv-mode-notes', 'rv-mode-highlight'); document.body.classList.add('rv-mode-' + mode);
    renderSwitch(); renderSources(); changed();
    if (sources.length > 1) window.LabSide?.tab('sources', { expand: false });
    emit();
    setInterval(() => { if (saveState !== 'none' || signature()) changed(); placeChip(); }, 600);
  }
  window.RV = {
    mode: () => mode, setMode, press, sources: () => sources, cur: () => cur, source: () => srcOf(cur), setSource,
    onChange: fn => { listeners.add(fn); return () => listeners.delete(fn); }, changed, storeKey, ready: () => ready,
    reel: (text) => { if (!reelBadge) return; reelBadge.classList.toggle('rv-on', !!text); reelBadge.querySelector('span').textContent = text || ''; },
    agentText, simulateReply, title: TITLE, modes: () => MODES.slice(), config: CFG
  };
  start();
}
