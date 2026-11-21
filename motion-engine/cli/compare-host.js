/* The host of `greenlight-motion review <dir> <dir2> …` (cli/compare.mjs serves it with window.GLMC_DATA): several films
   in ONE studio (GreenLightMotion.mountStudio, the board's review card: Notes and Highlight across sources A, B, C …),
   adapted from the board card's host (frontend/public/review-card/card.js). A source plays its folder's RENDER (a video
   over an empty film as long as the shared timeline, held to the page's playhead, as on the board) or its LIVE PROJECT:
   the studio holds one engine page, so a live source is mounted when it is picked (window.LabEdit.mount, with its own
   files through the assets resolver below, padded to the shared length) and a render source switches in place.
   Each film's parts (a scene script's scenes) go on the timeline's PARTS row while it is on show. The PICK (top bar):
   the film to go on with, or a mix, with a note. Save for agent posts everything to the CLI, which writes review/.
   ONE film (`review <dir>`): the single-film studio — Edit · Notes · Highlight on its live project (Notes · Highlight over
   its render), no pick, no film keys; the same save and files. */
(() => {
  const D = window.GLMC_DATA, G = window.GreenLightMotion, $ = s => document.querySelector(s);
  if (!D || !G) { const l = document.getElementById('loading'); if (l) l.textContent = 'The engine did not load: run the review command again.'; return; }
  // the engine answers every /… fetch itself (assets.js): this page's own calls go on the fetch it had before the engine
  const net = window.GLMC_FETCH || window.fetch.bind(window), FPS = D.fps || 30, FILMS = D.films;
  const byKey = Object.fromEntries(FILMS.map(f => [f.key, f])), isVid = k => byKey[k]?.plays === 'video';
  // one film: the single-film studio (no pick, no film keys; Edit on a live film, as the folder's own page has it)
  const SINGLE = FILMS.length === 1, MODES = D.modes || ['notes', 'highlight'];
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const store = { get: (k, d) => { try { return JSON.parse(localStorage.getItem(D.storeKey + k)) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(D.storeKey + k, JSON.stringify(v)); } catch {} } };
  const toast = t => window.LabSide?.toast(t);

  // ── what the engine page shows: the empty film under the videos, or a film's own project ──
  const shell = () => ({ name: D.title, videoSize: D.size, projectFps: FPS, background: { type: 'solid', solidColor: '#000000' },
    clips: [{ id: 'c-film', mediaType: 'shape', name: 'Film', duration: D.duration }],
    channels: [{ id: 'ch-film', name: 'Film', items: [{ id: 'film', clipId: 'c-film', trimStart: 0, trimEnd: D.duration, shapeType: 'rectangle', shapeFillColor: '#000000', shapeWidthPct: 1, shapeHeightPct: 1, opacity: 0 }] }] });
  const projects = {};
  async function projectOf(k) {
    if (!projects[k]) {
      const r = await net(byKey[k].project, { cache: 'no-store' });
      if (!r.ok) throw new Error(`${byKey[k].title}: its project.json did not load (HTTP ${r.status})`);
      const p = await r.json();
      p.projectFps = FPS;
      // the top bar names the review, whichever film is on show (the board card's title); the chip says which film
      if (!SINGLE) { if (p.template) p.template = { ...p.template, title: D.title }; else p.name = D.title; }
      // a shorter film runs to the shared length (an invisible layer at the bottom), so every source has the same timeline
      if (byKey[k].duration < D.duration - 0.5 / FPS) {
        p.clips = [...(p.clips || []), { id: 'c-glmc-pad', mediaType: 'shape', name: 'Review length', duration: D.duration }];
        p.channels = [{ id: 'ch-glmc-pad', name: 'Review length', unsnapped: true, items: [{ id: 'glmc-pad', clipId: 'c-glmc-pad', freeStart: 0, trimStart: 0, trimEnd: D.duration, shapeType: 'rectangle', shapeFillColor: '#000000', shapeWidthPct: 1, shapeHeightPct: 1, opacity: 0 }] }, ...(p.channels || [])];
      }
      projects[k] = p;
    }
    return structuredClone(projects[k]);
  }
  let mounted = null;   // the film whose project is on the page; '' = the empty film the videos play over
  // the page's files: the mounted film's own (its assets/ as the CLI serves them); `keys` lists them (plugins, fonts)
  const resolver = ref => (mounted && byKey[mounted]?.assets?.[ref]) || null;
  Object.defineProperty(resolver, 'keys', { get: () => Object.keys((mounted && byKey[mounted]?.assets) || {}) });

  // ── the page API, wrapped: on the empty film a video plays over it (the engine rebinds it on every render) ──
  let wrapped = null;
  Object.defineProperty(G, 'page', { configurable: true, get: () => wrapped,
    set: v => { wrapped = v ? Object.assign({}, v, { layers: () => (mounted ? v.layers() : []), values: () => (mounted ? v.values() : {}), renderFrame: t => (mounted ? v.renderFrame(t) : grab(t)) }) : v; } });
  const cur = () => window.RV?.cur() || FILMS[0].key;

  // ── switching sources: one at a time, in order (a second press waits for the first page to be up) ──
  let chain = Promise.resolve();
  function activate(k, t) {
    chain = chain.then(async () => {
      if (isVid(k)) { if (mounted !== '') { mounted = ''; await window.LabEdit.mount(shell(), { at: t }); } }
      else if (mounted !== k) {
        const proj = await projectOf(k), was = mounted;
        mounted = k;
        if (!(await window.LabEdit.mount(proj, { at: t }))) mounted = was;
      }
      showParts(k);
    }).catch(e => { console.error(e); toast(`Could not open ${byKey[k]?.title}: ${e.message}`); });
    return chain;
  }

  // ── a film's parts on the PARTS row while it is on show (the studio draws the row once, from window.RV_PARTS) ──
  const partsDiffer = FILMS.some(f => JSON.stringify(f.parts || []) !== JSON.stringify(FILMS[0].parts || []));
  let partsShown = null;
  function showParts(k) {
    window.RV_PARTS = byKey[k]?.parts || [];
    if (!partsDiffer || partsShown === k) return;
    const lane = $('.hl-tl .hl-parts'); if (!lane) return;
    partsShown = k;
    const parts = window.RV_PARTS, N = D.frames;
    lane.closest('.hl-prow').hidden = !parts.length;   // a film without parts has no PARTS row
    lane.innerHTML = parts.map((p, i) => { const a = Math.round(p[1] * FPS), b = i + 1 < parts.length ? Math.round(parts[i + 1][1] * FPS) : N; return `<span class="hl-part" data-i="${i}" title="${esc(p[0])} · ${esc(p[2] || '')} (${(a / FPS).toFixed(2)}–${(b / FPS).toFixed(2)} s)" style="left:${(a / N * 100).toFixed(4)}%;width:${((b - a) / N * 100).toFixed(4)}%"><i></i><span>${esc(p[0])}</span></span>`; }).join('');
  }
  // the part under the playhead lights up (the studio does it for the row it drew)
  function paintPart() {
    if (!partsDiffer || !wrapped?.ready) return;
    const f = Math.floor((wrapped.state().playhead ?? 0) * FPS + 1e-3); let on = -1;
    (window.RV_PARTS || []).forEach((p, i) => { if (Math.round(p[1] * FPS) <= f) on = i; });
    document.querySelectorAll('.hl-tl .hl-parts .hl-part').forEach((e, i) => e.classList.toggle('is-on', i === on));
  }

  // ── videos over the empty film (the board card's, card.js) ──
  const vids = {};
  function mountVideos() {
    const f = $('.glm-frame'); if (!f) return false;
    let box = f.querySelector(':scope > .rvc-videos');
    if (!box) { box = document.createElement('div'); box.className = 'rvc-videos'; f.append(box); Object.values(vids).forEach(v => box.append(v)); }
    for (const s of FILMS) if (s.video && !vids[s.key]) {
      const v = document.createElement('video'); v.className = 'rvc-v'; v.src = s.video; v.preload = 'metadata'; v.playsInline = true; v.muted = true; v.dataset.k = s.key;
      v.setAttribute('aria-label', s.title); box.append(v); vids[s.key] = v;
    }
    box.hidden = mounted !== '';
    return true;
  }
  // Playing, the video follows the page's clock: a small gap is closed by the playback rate, only a jump seeks (aimed where
  // the clock will be when the seek lands, learnt from the last one) — card.js has the measurements behind it.
  const SEEK_GAP_MS = 1000, JUMP_S = 0.5, sync = new WeakMap();
  const syncOf = v => sync.get(v) || (sync.set(v, { starting: false, seekAt: 0, aim: null, lead: 0.15 }), sync.get(v));
  const setRate = (v, r) => { if (Math.abs(v.playbackRate - r) > 0.03 || (r === 1 && v.playbackRate !== 1)) v.playbackRate = r; };
  function follow(v, t) {
    const y = syncOf(v), now = performance.now();
    if (v.paused) {
      if (y.starting) return;
      y.starting = true; y.aim = 0; y.seekAt = now; v.playbackRate = 1; v.currentTime = t; v.muted = false;
      v.play().catch(() => { v.muted = true; return v.play(); }).catch(() => {}).finally(() => { y.starting = false; });
      return;
    }
    if (v.seeking) return;
    const drift = v.currentTime - t;
    if (y.aim != null) { y.lead = Math.min(1.5, Math.max(0.05, y.aim - drift)); y.aim = null; }
    if (Math.abs(drift) > JUMP_S && now - y.seekAt >= SEEK_GAP_MS) { y.seekAt = now; y.aim = y.lead; v.playbackRate = 1; v.currentTime = Math.max(0, Math.min(t + y.lead, (v.duration || 1e9) - 0.05)); return; }
    setRate(v, Math.abs(drift) < 0.04 ? 1 : Math.min(1.25, Math.max(0.8, 1 - drift)));
  }
  let lastVid = null;
  function tick() {
    const p = wrapped;
    if (p?.ready && mountVideos()) {
      const v = mounted === '' ? vids[cur()] : null, s = p.state(), t = s.playhead ?? s.currentTime ?? 0;
      if (v !== lastVid) { Object.values(vids).forEach(x => { const on = x === v; x.classList.toggle('rvc-on', on); if (!on) { x.pause(); x.muted = true; } }); if (v) v.preload = 'auto'; lastVid = v; }
      if (v) {
        if (s.playing) follow(v, t);
        else {
          if (!v.paused) v.pause();
          const want = Math.min(Math.floor(t * FPS + 1e-3) / FPS + 0.5 / FPS, (v.duration || 1e9) - 1e-3);   // frame n shows at (n + 0.5) / fps
          if (!v.seeking && Math.abs(v.currentTime - want) > 0.4 / FPS) v.currentTime = want;
        }
      }
      paintPart();
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  window.addEventListener('rv:remount', () => mountVideos());
  // a video still without its picture says so at the frame's corner (card.js busyNote, its simple form)
  setInterval(() => {
    const view = $('.glm-view'), f = $('.glm-frame'), v = lastVid;
    let el = view?.querySelector(':scope > .rvc-busy');
    const failed = v?.error, busy = v && (failed || (!wrapped?.state?.().playing && (v.seeking || v.readyState < 2)));
    if (!view || !f || !busy) { el?.remove(); return; }
    if (!el) { el = document.createElement('div'); el.className = 'rvc-busy'; el.setAttribute('role', 'status'); el.innerHTML = '<span class="rvc-busy-spin" aria-hidden="true"></span><span class="rvc-busy-label"></span>'; view.append(el); }
    const vr = view.getBoundingClientRect(), fr = f.getBoundingClientRect();
    el.style.left = `${Math.round(fr.left - vr.left + 12)}px`; el.style.bottom = `${Math.round(vr.bottom - fr.bottom + 12)}px`;
    el.classList.toggle('rvc-busy-failed', !!failed);
    el.lastChild.textContent = failed ? 'The video could not be loaded' : 'Loading the video';
  }, 300);

  // a frame for Notes from a video: a detached copy of it, so the one on screen never jumps (card.js grab)
  const caps = {};
  const once = (el, ev, ms) => new Promise((ok, no) => { const t = setTimeout(() => { el.removeEventListener(ev, h); no(new Error('the video did not answer in time')); }, ms); const h = () => { clearTimeout(t); ok(); }; el.addEventListener(ev, h, { once: true }); });
  async function grab(t) {
    const s = byKey[cur()];
    if (!s?.video) throw new Error('this source has no video');
    let v = caps[s.key];
    if (!v) { v = caps[s.key] = document.createElement('video'); v.src = s.video; v.preload = 'auto'; v.muted = true; v.playsInline = true; }
    if (v.readyState < 1) await once(v, 'loadedmetadata', 15000);
    const want = Math.min(Math.max(0, Math.floor(t * FPS + 1e-3) / FPS + 0.5 / FPS), v.duration - 1e-3);
    if (Math.abs(v.currentTime - want) > 1e-3) { v.currentTime = want; await once(v, 'seeked', 15000); }
    else if (v.readyState < 2) await once(v, 'loadeddata', 15000);
    const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight; c.getContext('2d').drawImage(v, 0, 0);
    return c.toDataURL('image/jpeg', 0.92);
  }

  // ── the pick: the film to go on with, or a mix (its note says how) ──
  let pick = store.get('-pick', { film: null, mix: false, note: '' });
  if (pick.film && !byKey[pick.film]) pick = { film: null, mix: false, note: pick.note || '' };
  const hasPick = () => !SINGLE && !!(pick.film || pick.mix || (pick.note || '').trim());
  const pickExtra = () => (hasPick() ? { payload: { pick: { film: pick.film, mix: !pick.film && pick.mix, note: (pick.note || '').trim() } }, count: 0,
    lines: [`PICK: ${pick.film ? byKey[pick.film].title : pick.mix ? 'a mix' : 'none'}${(pick.note || '').trim() ? ` · "${pick.note.trim()}"` : ''}`] } : null);
  const svg = p => `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
  const IC = { pick: svg('<circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.8 2.8L16.5 9.5"/>'), mix: svg('<path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/>') };
  let pickBtn = null, pickPop = null;
  function buildPick() {
    pickBtn = document.createElement('button'); pickBtn.type = 'button'; pickBtn.className = 'glmc-pickb';
    pickBtn.title = 'Pick the film your agent goes on with, or a mix';
    pickBtn.onclick = e => { e.stopPropagation(); pickPop.hidden ? openPick() : (pickPop.hidden = true); };
    pickPop = document.createElement('div'); pickPop.className = 'glmc-pop'; pickPop.hidden = true; pickPop.setAttribute('role', 'dialog'); pickPop.setAttribute('aria-label', 'Your pick');
    const strips = window.RV_STRIPS || {};
    pickPop.innerHTML = `<div class="glmc-pop-h"><b>Your pick</b></div><div class="glmc-opts" role="radiogroup" aria-label="Films">${FILMS.map(f => `<button type="button" class="glmc-opt" role="radio" data-k="${f.key}"><span class="rv-src-po" style="background-image:url('${esc(strips[f.key]?.poster || '')}')"></span><span class="glmc-opt-tx"><b><i class="rv-dot" style="background:${f.colour}"></i>${esc(f.title)}</b><small>${esc(f.sub || '')}</small></span><span class="glmc-tick">${IC.pick}</span></button>`).join('')}<button type="button" class="glmc-opt glmc-mix" role="radio" data-k="mix"><span class="glmc-mixic">${IC.mix}</span><span class="glmc-opt-tx"><b>A mix of them</b><small>Say how in the note</small></span><span class="glmc-tick">${IC.pick}</span></button></div><label class="glmc-notef"><span>Note</span><textarea rows="3" placeholder="Why this one, or how to mix them" aria-label="Note on your pick"></textarea></label><div class="rv-pop-row"><button type="button" class="rv-cta" data-a="clear">Clear</button><span class="glmc-grow"></span><button type="button" class="rv-cta glmc-done" data-a="done">Done</button></div>`;
    pickPop.querySelectorAll('.glmc-opt').forEach(b => b.onclick = () => { const k = b.dataset.k; if (k === 'mix') pick = { ...pick, film: null, mix: !pick.mix || !!pick.film }; else pick = { ...pick, film: pick.film === k ? null : k, mix: false }; keepPick(); });
    const ta = pickPop.querySelector('textarea');
    ta.oninput = () => { pick = { ...pick, note: ta.value }; keepPick(false); };
    ta.onkeydown = e => { e.stopPropagation(); if (e.key === 'Escape') pickPop.hidden = true; };
    pickPop.querySelector('[data-a=clear]').onclick = () => { pick = { film: null, mix: false, note: '' }; ta.value = ''; keepPick(); };
    pickPop.querySelector('[data-a=done]').onclick = () => { pickPop.hidden = true; };
    document.addEventListener('pointerdown', e => { if (!pickPop.hidden && !pickPop.contains(e.target) && !pickBtn.contains(e.target)) pickPop.hidden = true; }, true);
    document.addEventListener('keydown', e => { if (!pickPop.hidden && e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); pickPop.hidden = true; } }, true);
    document.body.append(pickPop);
    placePick(); paintPick();
  }
  function placePick() { const top = $('.glm-top'); if (top && pickBtn && pickBtn.parentNode !== top) top.append(pickBtn); }
  function openPick() {
    pickPop.querySelector('textarea').value = pick.note || '';
    const r = pickBtn.getBoundingClientRect();
    pickPop.style.top = `${Math.round(r.bottom + 6)}px`; pickPop.style.right = `${Math.max(8, Math.round(window.innerWidth - r.right))}px`;
    pickPop.hidden = false; paintPick();
  }
  function keepPick(repaint = true) { store.set('-pick', pick); if (repaint) paintPick(); else paintBtn(); window.RV?.changed(); }
  function paintBtn() {
    if (!pickBtn) return;
    const f = pick.film && byKey[pick.film];
    pickBtn.classList.toggle('glmc-on', !!(f || pick.mix));
    pickBtn.innerHTML = f ? `<i class="rv-dot" style="background:${f.colour}"></i><span>Pick: <b>${esc(f.key)}</b></span>` : pick.mix ? `${IC.mix}<span>Pick: <b>a mix</b></span>` : `${IC.pick}<span>Pick a film</span>`;
    pickBtn.setAttribute('aria-label', f ? `Your pick: ${f.title}` : pick.mix ? 'Your pick: a mix' : 'Pick a film');
  }
  function paintPick() {
    paintBtn();
    pickPop?.querySelectorAll('.glmc-opt').forEach(b => { const on = b.dataset.k === 'mix' ? !pick.film && pick.mix : b.dataset.k === pick.film; b.setAttribute('aria-checked', String(on)); b.classList.toggle('glmc-sel', on); });
    // the Sources list shows the pick on its film's row
    document.querySelectorAll('#source-list .rv-src').forEach(b => {
      let tag = b.querySelector('.glmc-srcpick');
      if (!tag) { tag = document.createElement('span'); tag.className = 'glmc-srcpick'; tag.title = 'Your pick'; tag.setAttribute('aria-label', 'your pick'); tag.innerHTML = IC.pick; b.querySelector('.rv-src-tx b')?.append(tag); }
      tag.hidden = b.dataset.k !== pick.film;
    });
  }

  // ── Save for agent: the whole review to the CLI, which writes <out>/review/ ──
  async function save({ payload, notes }) {
    const body = JSON.stringify({ payload, notes: notes.map(n => ({ n: n.n, id: n.id, text: n.text, createdAt: n.createdAt, thread: (n.thread || []).map(c => ({ by: c.by, text: c.text, at: c.at })),
      shots: n.shots.map(s => ({ src: s.src || FILMS[0].key, kind: s.kind, t: s.t, end: s.end, marks: (s.marks || []).length, layers: (s.layers || []).map(l => l.id), image: s.image || null })) })) });
    const r = await net('/__glm/compare/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    if (!r.ok) { let d = ''; try { d = (await r.json()).error; } catch {} throw new Error(d || `The review server answered HTTP ${r.status}. Is greenlight-motion review still running?`); }
    return { where: D.out.split(/[\\/]/).slice(-2).join('/') + '/' };   // <folder>/review/
  }

  // ── the studio ──
  window.RV_SOURCES = FILMS.map(f => ({ k: f.key, title: f.title, sub: f.sub || '', col: f.colour, video: f.video, cuts: Array.isArray(f.cuts) && f.cuts.length ? f.cuts : null, values: {}, layers: {} }));
  window.RV_STRIPS = Object.fromEntries(FILMS.filter(f => f.strip).map(f => [f.key, { strip: f.strip.src, n: f.strip.n, step: f.strip.step, tw: f.strip.tw, th: f.strip.th, poster: f.poster }]));
  window.RV_CONFIG = {
    title: D.title, modes: MODES, start: D.start || 'highlight', storeKey: D.storeKey, fps: FPS, startAt: 0, ...(MODES.includes('edit') ? {} : { markers: false }),
    filePrefix: String(D.title || 'review').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'review',
    onSource: (prev, next, t) => activate(next, t), extra: pickExtra, save,
    saveTitle: `Write your notes, highlights${SINGLE ? '' : ' and pick'} to review/ for your agent`, savedText: 'Saved for the agent',
  };
  (async () => {
    // the source the studio shows first (review.js keeps the last one in <storeKey>-src): its page goes up first
    let first = null; try { first = localStorage.getItem(D.storeKey + '-src'); } catch {}
    if (!byKey[first]) first = FILMS[0].key;
    mounted = isVid(first) ? '' : first;
    // the PARTS row exists only when the studio is given parts: the first film's, else any film's (swapped at start)
    window.RV_PARTS = byKey[first].parts?.length ? byKey[first].parts : (FILMS.find(f => f.parts?.length)?.parts || []);
    const project = mounted ? await projectOf(first) : shell();
    $('#loading')?.remove();
    G.mountStudio(document.getElementById('app'), { project, assets: resolver, chat: { full: true } });
    (function start() {
      if (!window.RV?.ready() || !wrapped?.ready || !$('.glm-top') || !$('.hl-tl')) { setTimeout(start, 100); return; }
      showParts(cur());
      if (!SINGLE) { buildPick(); window.addEventListener('rv:remount', () => { placePick(); }); window.RV.onChange(paintPick); }
      document.body.classList.add('glmc-ready');
      window.RV.changed();
    })();
  })().catch(e => { console.error(e); const l = document.getElementById('loading'); if (l) l.textContent = `The review could not start: ${e.message}`; });
  window.GLMC = { activate, mounted: () => mounted, pick: () => ({ ...pick }), setPick: p => { pick = { film: null, mix: false, note: '', ...p }; keepPick(); }, films: FILMS };
})();
