// The studio in a chat's frame: mountStudio(el, { chat: { height, full, onExpand } }) — the chat layout lab's Variant 5 ·
// Mobile (html/INTERFACE/motion-chat-layout-lab, 2026-10-26; its look: chat.css). Up to 900 px wide — a phone's chat
// and a computer's alike — the app's mobile editor in a box of the chat's height: the timeline always there, zoomed and
// scrolling sideways (100 px a second at first, pinch or ctrl + wheel to zoom, kept), the studio's own toolbar on top of
// it with Properties · Layers first, a panel a sheet sliding over the timeline (Done closes it). A tap picks a layer, a
// double tap opens its Properties. Notes and Highlight: their strip only as tall as it needs, their panel docked under
// it. The timeline's top edge is a handle (kept per film shape). Wider than 900 px (full screen): the studio's
// whole-window layout. The page tells it the box's height and whether it is full screen (set()); the Expand button
// (600 px and wider, when the host can go full screen) asks the page through onExpand(full).
// body.cl-c.cl-a.cl-stack = the layout · .cl-asphone = 600–900 px · body[data-cl-tab] = the open sheet: '' | side | panel
const B = document.body;
const svg = (d, w = 17) => `<svg viewBox="0 0 24 24" width="${w}" height="${w}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICON = {
  expand: svg('<path d="M14 4h6v6M10 20H4v-6M20 4l-6.5 6.5M4 20l6.5-6.5"/>', 15),
  shrink: svg('<path d="M20 10h-6V4M4 14h6v6M14 10l6.5-6.5M10 14l-6.5 6.5"/>', 15),
};
const TB = {   // the toolbar's own buttons, 14 px as the studio's
  panel: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5zM3 13l9 5 9-5"/>',
  project: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  sources: '<rect x="3" y="5" width="13" height="14" rx="2"/><path d="M19 7v10M22 9v6"/>',
};
const LIST_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/></svg>';
const SRC_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${TB.sources}</svg>`;
const LABEL = { edit: 'Properties', notes: 'Notes', highlight: 'Highlights' };
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* a private window */ } },
};

// no purple: the studio's violet / purple / indigo turned white (light ones) or a grey of the same lightness (dark tints)
function hsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  let h = 0, s = 0;
  if (d) { s = d / (1 - Math.abs(2 * l - 1)); h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h = (h * 60 + 360) % 360; }
  return { h, s, l };
}
export function whiten(text) {
  return String(text).replace(/rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)|#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b/g, (m, r, g, b, a, hex) => {
    if (hex) {   // #rgb, #rgba, #rrggbb, #rrggbbaa
      if (hex.length <= 4) hex = hex.replace(/./g, '$&$&');
      r = parseInt(hex.slice(0, 2), 16); g = parseInt(hex.slice(2, 4), 16); b = parseInt(hex.slice(4, 6), 16);
      if (hex.length === 8) a = String(Math.round(parseInt(hex.slice(6, 8), 16) / 255 * 1000) / 1000);
    }
    const c = hsl(+r, +g, +b), alpha = a == null ? 1 : /%$/.test(a) ? parseFloat(a) / 100 : +a;
    if (!(c.h >= 235 && c.h <= 300 && c.s >= 0.2)) return m;
    if (c.l >= 0.4) return alpha < 1 ? `rgba(237, 241, 238, ${alpha})` : '#edf1ee';
    const v = Math.round(c.l * 255);
    return alpha < 1 ? `rgba(${v}, ${v}, ${v}, ${alpha})` : `rgb(${v}, ${v}, ${v})`;
  });
}

export function install(STUDIO, opts = {}) {
  const S = { height: +opts.height || 780, full: !!opts.full, onExpand: typeof opts.onExpand === 'function' ? opts.onExpand : null };
  let compact = false, expandBtn = null, split = null, done = null, started = false;
  const api = () => window.GreenLightMotion && window.GreenLightMotion.page;
  const mode = () => (/\brv-mode-(\w+)/.exec(B.className) || [])[1] || 'edit';
  const stack = () => B.classList.contains('cl-stack');
  // the sheet that opens by itself with a mode: a wide film's Notes / Highlights, docked, always
  const firstTab = (m) => (m !== 'edit' && B.classList.contains('cl-wide') ? 'panel' : '');

  function show(tab) {
    B.dataset.clTab = tab;
    B.classList.toggle('cl-open', !!tab);
    if (tab !== 'side') {
      document.querySelectorAll('.lab-rail [data-tab]').forEach((b) => { b.classList.remove('active'); b.setAttribute('aria-pressed', 'false'); });
      document.querySelector('.lab-side')?.classList.remove('expanded');   // the rail's pane folds away
    } else if (window.LabSide && LabSide.active()) {
      // the pane's own tab lit again: Layers from Notes or Highlight switches the studio to Edit, and that mode change
      // came through here as 'panel' first and unlit it
      document.querySelectorAll('.lab-rail [data-tab]').forEach((b) => { const on = b.dataset.tab === LabSide.active(); b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on)); });
    }
    measure();
  }
  function shape(project) {
    const s = (project && project.videoSize) || { w: 16, h: 9 };
    B.classList.toggle('cl-tall', s.h > s.w); B.classList.toggle('cl-wide', !(s.h > s.w));
    B.style.setProperty('--cl-ar', String(s.w / s.h));
  }
  // the layout from the width: up to 900 px the mobile editor in its box; wider the whole-window studio
  function apply() {
    const w = window.innerWidth, was = compact;
    compact = w <= 900;
    B.style.setProperty('--cl-box', (S.full ? window.innerHeight : S.height) + 'px');   // the chat's height for it, or the whole screen
    B.classList.toggle('cl-c', compact);
    B.classList.toggle('cl-a', compact);
    B.classList.toggle('cl-stack', compact);
    B.classList.toggle('cl-asphone', compact && w >= 600);   // a computer's chat, an iPad
    if (split) restoreSplit();
    if (compact && started) setup();
    if (compact && started && (was !== compact || B.dataset.clTab == null)) show(firstTab(mode()));
    if (expandBtn) {
      // a phone has nothing to expand into; a host that can't go full screen gets no button
      expandBtn.hidden = !S.onExpand || w < 600;
      expandBtn.innerHTML = S.full ? ICON.shrink : ICON.expand;
      expandBtn.title = S.full ? 'Back into the chat' : 'Full screen';
      expandBtn.setAttribute('aria-label', expandBtn.title);
    }
    measure();
  }

  // the rows fill the timeline down to its bottom edge (the toolbar and the ruler above them stay)
  const ro = window.ResizeObserver ? new ResizeObserver(() => measure()) : null;
  let watched = null;
  // Edit's timeline: only the lanes scroll sideways — the bar (the ruler, the rows, the playhead) in a scroller of its
  // own, so the toolbar, the names column and their head stay put; undone for the whole-window layout
  function lanes() {
    const tl = document.querySelector('#app .glm-tlwrap'); if (!tl) return;
    let wrap = tl.querySelector(':scope > .cl-lanes');
    const bar = tl.querySelector('.glm-bar');
    if (stack()) {
      if (bar && bar.parentNode === tl) { if (!wrap) { wrap = document.createElement('div'); wrap.className = 'cl-lanes'; } tl.insertBefore(wrap, bar); wrap.append(bar); }
    } else if (wrap) { if (bar && bar.parentNode === wrap) tl.insertBefore(bar, wrap); wrap.remove(); }
  }
  function measure() {
    lanes();
    const tl = document.querySelector('.glm-tlwrap'), rows = document.querySelector('.glm-rows');
    if (tl && ro && tl !== watched) { if (watched) ro.unobserve(watched); ro.observe(tl); watched = tl; }
    if (!compact || !tl || !rows || !tl.offsetHeight) { ['--cl-rows', '--cl-barw', '--cl-tlvw', '--cl-hlw', '--cl-hlvw'].forEach((v) => B.style.removeProperty(v)); return; }
    const pg = api();
    if (pg && pg.duration > 0) {
      const tcs = getComputedStyle(tl), padX = (parseFloat(tcs.paddingLeft) || 0) + (parseFloat(tcs.paddingRight) || 0);
      B.style.setProperty('--cl-barw', Math.max(tl.clientWidth - padX, Math.round(pg.duration * PPS)) + 'px');
      B.style.setProperty('--cl-tlvw', tl.clientWidth + 'px');   // the toolbar: the strip's visible width
    }
    // Notes and Highlight's timeline: its labels + the lanes at the same scale; its toolbar the view's width inside the
    // strip's own side padding
    const hl = document.querySelector('.hl-tl'), lab = hl && hl.querySelector('.hl-lab');
    if (hl && hl.clientWidth && pg && pg.duration > 0) {
      const hcs = getComputedStyle(hl), pad = (parseFloat(hcs.paddingLeft) || 0) + (parseFloat(hcs.paddingRight) || 0), lw = lab ? lab.offsetWidth : 58;
      B.style.setProperty('--cl-hlw', Math.max(hl.clientWidth - pad, lw + Math.round(pg.duration * PPS)) + 'px');
      B.style.setProperty('--cl-hlvw', (hl.clientWidth - pad) + 'px');
    } else { B.style.removeProperty('--cl-hlw'); B.style.removeProperty('--cl-hlvw'); }
    stripHeight();
    // the names column starts where the first row does (the rows' own top + their padding: steady while they scroll)
    const row0 = rows.getBoundingClientRect().top + parseFloat(getComputedStyle(rows).paddingTop) - tl.getBoundingClientRect().top - tl.clientTop;
    B.style.setProperty('--cl-lt', row0 + 'px');
    const h = Math.floor(tl.getBoundingClientRect().bottom - rows.getBoundingClientRect().top - 6);
    if (h > 40) B.style.setProperty('--cl-rows', h + 'px');
  }
  // Notes and Highlight's strip: as tall as its toolbar, ruler and lanes (one per source), at most 40 % of the box (more
  // sources scroll); the docked panel takes what is left
  function stripHeight() {
    const hl = document.querySelector('.hl-tl');
    if (!stack() || mode() === 'edit' || !hl || !hl.offsetParent) { B.style.removeProperty('--cl-strip'); return; }
    let h = 0;
    for (const c of hl.children) if (c.offsetParent) h += c.offsetHeight;
    h = Math.min(Math.round(h + parseFloat(getComputedStyle(hl).paddingBottom || 0) + 2), Math.round(B.getBoundingClientRect().height * 0.4));
    if (h > 60 && B.style.getPropertyValue('--cl-strip') !== h + 'px') B.style.setProperty('--cl-strip', h + 'px');
  }

  // the handle: the timeline's top edge — drag up for more timeline, down for a bigger preview (kept per shape); in
  // Notes and Highlight it sizes the panel docked under their strip
  const shapeKey = () => (B.classList.contains('cl-tall') ? 'tall' : 'wide');
  const tlKey = () => 'glm-chat-tl-' + shapeKey();
  const dockKey = () => 'glm-chat-dock-' + shapeKey();
  function restoreSplit() {
    const v = store.get(tlKey());
    if (v) B.style.setProperty('--cl-tl', v + 'px'); else B.style.removeProperty('--cl-tl');
    B.classList.toggle('cl-tlset', !!v && stack());   // the grid takes --cl-tl only once it was dragged
    const d = store.get(dockKey());
    if (d && stack()) { B.style.setProperty('--cl-dock', d + 'px'); B.classList.add('cl-dockset'); } else { B.style.removeProperty('--cl-dock'); B.classList.remove('cl-dockset'); }
  }
  function addSplit() {
    if (split) return;
    split = document.createElement('div'); split.className = 'cl-split'; split.setAttribute('role', 'separator'); split.setAttribute('aria-orientation', 'horizontal');
    split.title = 'Drag: more timeline or a bigger preview';
    split.addEventListener('pointerdown', (e) => {
      const tl = document.querySelector('.glm-tlwrap'); if (!tl) return;
      e.preventDefault(); split.setPointerCapture(e.pointerId); split.classList.add('on');
      const y0 = e.clientY, h0 = tl.getBoundingClientRect().height, box = B.getBoundingClientRect().height;
      const upMin = parseFloat(getComputedStyle(B).getPropertyValue('--cl-up-min')) || 298;   // what stays over the timeline
      // Notes and Highlight: the strip keeps its height, the handle sizes the panel docked under it (a tall film's,
      // closed until asked for, comes up when the handle is pulled up)
      const dock = stack() && mode() !== 'edit', side = document.querySelector('#app .glm-side');
      const d0 = dock && B.dataset.clTab === 'panel' && side && side.offsetParent ? side.getBoundingClientRect().height + 8 : 0;
      let h = h0, d = d0;
      const move = (ev) => {
        if (dock) {
          d = Math.round(d0 - (ev.clientY - y0));
          if (d > 40 && B.dataset.clTab !== 'panel') { autoOpen = false; show('panel'); tbButtons(); }
          d = Math.max(120, Math.min(box - upMin - h0, d));
          B.style.setProperty('--cl-dock', d + 'px'); B.classList.add('cl-dockset'); measure(); return;
        }
        h = Math.round(Math.max(140, Math.min(box - upMin, h0 - (ev.clientY - y0))));
        B.style.setProperty('--cl-tl', h + 'px'); B.classList.toggle('cl-tlset', stack()); measure();
      };
      const up = () => {
        split.classList.remove('on'); split.removeEventListener('pointermove', move); split.removeEventListener('pointerup', up); split.removeEventListener('pointercancel', up);
        if (dock) { if (d !== d0) store.set(dockKey(), String(d)); } else store.set(tlKey(), String(h));
      };
      split.addEventListener('pointermove', move); split.addEventListener('pointerup', up); split.addEventListener('pointercancel', up);
    });
    B.append(split);
    restoreSplit();
  }
  // Full screen / back into the chat: in the app bar, before Open in GreenLight Dash
  function addExpand() {
    const top = document.querySelector('.glm-top'); if (!top) return;
    if (!expandBtn) {
      expandBtn = document.createElement('button'); expandBtn.type = 'button'; expandBtn.className = 'glm-tbtn cl-expand';
      expandBtn.onclick = () => { if (S.onExpand) S.onExpand(!S.full); };
    }
    if (!expandBtn.isConnected) top.append(expandBtn);
  }

  // the strip's scale: 100 px a second at first (≈3 s across a phone — clips at a size a finger can take), kept
  let PPS = (() => { const v = +store.get('glm-chat-pps'); return v >= 20 && v <= 240 ? v : 100; })();
  function openSheet(tab, pane) {
    const again = B.dataset.clTab === tab && (tab !== 'side' || (window.LabSide && LabSide.active() === pane));
    if (again) { show(tab === 'side' && mode() !== 'edit' ? firstTab(mode()) : ''); tbButtons(); return; }   // Notes · Highlight: a wide film's panel comes back
    if (pane && window.LabSide) LabSide.tab(pane, { expand: false });
    show(tab); tbButtons();
  }
  // the studio's own toolbar on top of the timeline, with Properties · Layers (and Sources, where there are several — a
  // review card's variants — and the page's Project, where it has one) first: they open the sheet over the timeline. The studio rebuilds the toolbar on every pick (replaceChildren): an
  // observer puts them back at once, before it paints
  function tbButtons() {
    const bar = document.querySelector('.rv-edit-toolbar'); if (!bar || !stack()) return;
    if (!bar.dataset.clObs) { bar.dataset.clObs = '1'; new MutationObserver(tbButtons).observe(bar, { childList: true }); }
    const shown = (k) => { const t = document.querySelector(`.lab-rail [data-tab=${k}]`); return !!t && !t.hidden; };
    const panes = ['sources', 'project'].filter(shown), sig = panes.join();
    if (!bar.querySelector('[data-cl-tb]') || bar.dataset.clPanes !== sig) {
      bar.dataset.clPanes = sig;
      bar.querySelectorAll('[data-cl-tb]').forEach((b) => b.remove());
      const mk = (key, label, title, fn) => {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'rv-act'; b.dataset.clTb = key; b.title = title;
        b.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${TB[key]}</svg><span>${label}</span>`;
        b.onclick = (e) => { e.stopPropagation(); fn(); }; return b;
      };
      const sep = document.createElement('i'); sep.className = 'rv-tsep'; sep.dataset.clTb = 'sep';
      const own = [mk('panel', LABEL[mode()], 'The picked layer’s properties (or the project’s)', () => openSheet('panel')),
        mk('layers', 'Layers', 'Every layer, by channel or by type', () => openSheet('side', 'layers'))];
      if (panes.includes('sources')) own.push(mk('sources', 'Sources', 'The versions to review: pick one', () => openSheet('side', 'sources')));
      if (panes.includes('project')) own.push(mk('project', 'Project', 'This video: your files, another project', () => openSheet('side', 'project')));
      bar.prepend(...own, sep);
    }
    const tab = B.dataset.clTab, pane = window.LabSide && LabSide.active();
    bar.querySelectorAll('[data-cl-tb=panel]').forEach((b) => b.classList.toggle('is-on', tab === 'panel'));
    bar.querySelectorAll('[data-cl-tb=layers]').forEach((b) => b.classList.toggle('is-on', tab === 'side' && pane === 'layers'));
    for (const k of ['sources', 'project']) bar.querySelectorAll(`[data-cl-tb=${k}]`).forEach((b) => b.classList.toggle('is-on', tab === 'side' && pane === k));
  }
  function listButton() {   // Notes and Highlight: the strip's toolbars are the studio's (rebuilt now and then) — put it back
    const m = mode(); if (m === 'edit') return;
    const bar = document.querySelector(m === 'notes' ? '.mn-toolbar .mn-tools, .mn-tools' : '.hl-tltools'); if (!bar || !bar.offsetParent) return;
    let b = bar.querySelector('.cl-listbtn:not(.cl-srcbtn)');
    if (!b) { b = document.createElement('button'); b.type = 'button'; b.className = 'cl-listbtn'; b.onclick = (e) => { e.stopPropagation(); autoOpen = false; openSheet('panel'); }; bar.append(b); }   // opens / closes the docked panel
    const n = m === 'notes' ? (window.LabNotes ? LabNotes.state().notes.length : 0) : (window.LabHighlight ? LabHighlight.list().length : 0);
    const html = LIST_ICON + '<span>' + (m === 'notes' ? 'Notes' : 'Highlights') + '</span>' + (n ? ' <b class="cl-n">' + n + '</b>' : '');   // the count a badge on the icon
    if (b.dataset.html !== html) { b.innerHTML = html; b.dataset.html = html; }
    const open = B.dataset.clTab === 'panel';
    b.classList.toggle('on', open); b.setAttribute('aria-pressed', String(open));
    b.title = (open ? 'Hide ' : 'Show ') + (m === 'notes' ? 'your notes' : 'your highlights');
    // several sources (a review card's versions): Sources just before the list — the strip shows the one on screen, the
    // rail that switched it is hidden here; its sheet docks under the strip like the panel
    const st = document.querySelector('.lab-rail [data-tab=sources]'), many = !!st && !st.hidden;
    let sb = bar.querySelector('.cl-srcbtn');
    if (many && !sb) {
      sb = document.createElement('button'); sb.type = 'button'; sb.className = 'cl-listbtn cl-srcbtn'; sb.innerHTML = SRC_ICON + '<span>Sources</span>'; sb.title = 'The versions to review: pick one';
      sb.onclick = (e) => { e.stopPropagation(); autoOpen = false; openSheet('side', 'sources'); };
    }
    if (sb && !many) sb.remove();
    else if (sb) {
      if (sb.nextElementSibling !== b) bar.insertBefore(sb, b);
      const on = B.dataset.clTab === 'side'; sb.classList.toggle('on', on); sb.setAttribute('aria-pressed', String(on));
      bar.style.setProperty('--cl-listw', b.offsetWidth + 'px');   // it sticks to the right end beside the list
    }
  }
  // a panel that came up by itself (a drawing, a tapped highlight) goes again when that work is done — on a tall film,
  // whose preview wants the room back; a wide film's panel is always there
  let autoOpen = false, lastHn = 0, lastSel, lastMode = '', lastOff = '', lastWork = false, lastEdit = false, lastRender = false;
  function autoClose() {
    if (autoOpen && B.classList.contains('cl-tall') && mode() !== 'edit' && B.dataset.clTab === 'panel') { show(''); tbButtons(); }
    autoOpen = false;
  }
  // scroll the panel's own list (never the page: its box is fixed) so that el shows whole
  function reveal(el) {
    if (!el) return;
    for (let sc = el.parentElement; sc && sc !== B; sc = sc.parentElement) {
      const o = getComputedStyle(sc).overflowY;
      if ((o === 'auto' || o === 'scroll') && sc.scrollHeight > sc.clientHeight) {
        const r = el.getBoundingClientRect(), b = sc.getBoundingClientRect();
        if (r.top < b.top + 8) sc.scrollTop -= b.top + 8 - r.top; else if (r.bottom > b.bottom - 8) sc.scrollTop += Math.min(r.bottom - b.bottom + 8, r.top - b.top - 8);
        return;
      }
    }
  }
  // a note's flag on a ruler covers the second's number under it: that number steps aside; a flag at the very start
  // would sit half under the names column — it opens to the right of 0 instead
  function flagsClear() {
    const rulers = [[document.querySelector('#app .glm-ruler'), '.glm-tick.is-major span', document.querySelector('.glm-tlwrap .mn-markers')],
      [document.querySelector('.hl-ruler'), '.hl-secm', document.querySelector('.hl-ruler')]];
    for (const [ruler, numbers, box] of rulers) {
      if (!ruler || !box || !ruler.offsetParent) continue;
      const flags = [...box.querySelectorAll('.mn-flag')], rr = ruler.getBoundingClientRect();
      flags.forEach((f) => f.classList.toggle('cl-edge', parseFloat(f.style.left) * rr.width / 100 < 8));
      const boxes = flags.map((f) => f.getBoundingClientRect());
      ruler.querySelectorAll(numbers).forEach((l) => {
        const b = l.getBoundingClientRect();
        l.classList.toggle('cl-under', boxes.some((f) => f.right + 2 > b.left && f.left - 2 < b.left + Math.min(b.width, 22) && f.bottom > b.top && f.top < b.bottom));
      });
    }
  }
  // a picture layer's Picture field: the studio shows its hidden <input type=file> as an empty text box — here a button
  // that opens the file picker instead
  function pictureFields() {
    document.querySelectorAll('.mi-row-text textarea.mi-text').forEach((ta) => {
      const native = document.getElementById(ta.id.replace(/^mi-/, '')); if (!native || native.type !== 'file') return;
      const b = document.createElement('button'); b.type = 'button'; b.className = 'cl-pic';
      b.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/></svg>Replace picture…';
      b.onclick = () => native.click();
      ta.replaceWith(b);
    });
  }
  // the engine groups several clips into one timeline row, its names column lists one name per clip: one name per row
  // here (the picked clip's, or the row's first), and the column's head on the ruler's row
  function alignTrackNames() {
    const tl = document.querySelector('.glm-tlwrap'), labels = tl && tl.querySelector('.lab-track-labels');
    if (!labels || mode() !== 'edit') return;
    const selected = api().selected(), order = new Map();
    tl.querySelectorAll('.glm-row').forEach((row, index) => {
      const clips = [...row.querySelectorAll('.glm-layer')];
      const clip = clips.find((el) => el.dataset.layer === selected) || clips[0];
      if (clip) order.set(clip.dataset.layer, index);
    });
    labels.querySelectorAll('.lab-track-label').forEach((label) => {
      const index = order.get(label.dataset.id);
      label.classList.toggle('cl-track-hidden', index == null);
      const value = index == null ? '' : String(index);
      if (label.style.order !== value) label.style.order = value;
    });
    if (!tl.querySelector('.cl-track-head')) {
      const head = document.createElement('div'); head.className = 'cl-track-head'; head.textContent = 'Layers';
      head.style.transform = `translateX(${tl.scrollLeft}px)`; tl.append(head);
    }
  }
  function tick() {   // cheap: the selection and the mode change the toolbar; playing keeps the playhead in view
    if (!stack()) return;
    const pg = api(); if (!pg || !pg.ready) return;
    alignTrackNames();
    // the studio enables its tools a moment after a selection: follow their state too
    const sel = pg.selected ? pg.selected() : null, m = mode(), off = [...document.querySelectorAll('.rv-edit-toolbar button')].map((b) => (b.disabled ? 1 : 0)).join('');
    if (sel !== lastSel || m !== lastMode || off !== lastOff) {
      if (m !== lastMode) setTimeout(measure, 60);
      lastSel = sel; lastMode = m; lastOff = off; tbButtons();
    }
    // a note under way (something drawn or placed): the Notes panel comes up — the writing box, Add note
    if (m === 'notes' && window.LabNotes) {
      const ns = LabNotes.state(), work = !!((LabNotes.hasWork && LabNotes.hasWork()) || (ns.draft && ns.draft.shots && ns.draft.shots.length));
      if (work && !lastWork) {
        autoOpen = B.dataset.clTab !== 'panel'; show('panel'); tbButtons();
        setTimeout(() => reveal(document.querySelector('.mn-composer .mn-actions') || document.querySelector('.mn-note-text')), 80);
      }
      if (!work && lastWork) autoClose();   // the note added (or dropped)
      lastWork = work;
    }
    // a highlight already made and tapped on the strip opens in the panel: its range and its note (typing saves it)
    if (m === 'highlight' && window.LabHighlight) {
      const hn = LabHighlight.list().length;   // a highlight added: the list shows from its header
      if (hn > lastHn && B.dataset.clTab === 'panel') setTimeout(() => { const sc = document.querySelector('.glm-side .hl-panel'), head = sc && sc.querySelector('.hl-sec-list');
        if (sc && head) sc.scrollTop += head.getBoundingClientRect().top - sc.getBoundingClientRect().top; }, 150);
      lastHn = hn;
      const ed = !!LabHighlight.state().edit;
      if (ed && !lastEdit) { autoOpen = B.dataset.clTab !== 'panel'; show('panel'); tbButtons(); setTimeout(() => reveal(document.querySelector('.glm-side .hl-note')), 80); }
      if (!ed && lastEdit) autoClose();   // Done / Cancel
      lastEdit = ed;
    }
    // Render (the app bar) shows its pane in the panel: the sheet comes up with it
    const rendering = !!document.querySelector('.glm-app.is-render');
    if (rendering && !lastRender && B.dataset.clTab !== 'panel') { show('panel'); tbButtons(); }
    lastRender = rendering;
    const ink = document.querySelector('.mn-ink');
    B.classList.toggle('cl-drawing', m === 'notes' && (!!document.querySelector('.mn-tools [data-note-tool][aria-pressed=true]') || !!(ink && !ink.hidden && ink.offsetParent)));
    listButton(); stripHeight(); flagsClear();
    const st = pg.state ? pg.state() : null, hlOn = m !== 'edit';
    const tl = document.querySelector(hlOn ? '.hl-tl' : '.cl-lanes, .glm-tlwrap'), bar = document.querySelector(hlOn ? '.hl-ruler' : '.glm-bar');
    if (st && st.playing && tl && bar && pg.duration > 0) {
      const x = (st.playhead || 0) / pg.duration * bar.offsetWidth + (bar.getBoundingClientRect().left - tl.getBoundingClientRect().left + tl.scrollLeft), v = tl.clientWidth;
      const gutter = hlOn ? (tl.querySelector('.hl-lab') || {}).offsetWidth || 58 : parseFloat(getComputedStyle(tl).paddingLeft) || 0;
      if (x < tl.scrollLeft + gutter + 12 || x > tl.scrollLeft + v - 24) tl.scrollLeft = Math.max(0, x - Math.max(gutter + 24, v * 0.3));
    }
  }
  let ready = false;
  function setup() {
    if (ready) return; ready = true;
    done = document.createElement('button'); done.type = 'button'; done.className = 'cl-done'; done.setAttribute('aria-label', 'Done'); done.title = 'Done';
    done.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5 9-10"/></svg><span>Done</span>';
    done.onclick = () => {
      if (mode() === 'highlight' && window.LabHighlight && LabHighlight.editing()) LabHighlight.finishEdit();
      const back = document.querySelector('.glm-app.is-render #glm-render-pane .glm-dhead .glm-icon');   // Render's pane: back to the options (not while it renders)
      if (back && !back.disabled) back.click();
      show(''); tbButtons();
    };
    B.append(done);
    // a tap anywhere on a highlight on the strip edits it (the studio starts that from the chip's small tag)
    document.addEventListener('click', (e) => {
      if (!stack() || mode() !== 'highlight') return;
      const chip = e.target.closest('.hl-hc'), tag = chip && chip.querySelector('.hl-hc-tag');
      if (!chip || !tag || e.target.closest('.hl-hc-tag')) return;
      e.stopPropagation(); e.preventDefault(); tag.click();
    }, true);
    // the names column, the toolbar and the column's head stay at the left if the timeline itself is scrolled
    document.addEventListener('scroll', (e) => {
      if (!e.target.classList || !e.target.classList.contains('glm-tlwrap') || !stack()) return;
      const labels = e.target.querySelector('.lab-track-labels'); if (labels) labels.style.left = (4 + e.target.scrollLeft) + 'px';
      const tb = e.target.querySelector('.rv-edit-toolbar'); if (tb) tb.style.transform = `translateX(${e.target.scrollLeft}px)`;
      const head = e.target.querySelector('.cl-track-head'); if (head) head.style.transform = `translateX(${e.target.scrollLeft}px)`;
    }, true);
    setInterval(tick, 200);
    // a version picked in the Sources sheet in Notes or Highlight: its strip, and the panel back where it was docked
    document.addEventListener('click', (e) => {
      if (stack() && mode() !== 'edit' && B.dataset.clTab === 'side' && e.target.closest('#source-list .rv-src')) setTimeout(() => { show(firstTab(mode())); tbButtons(); }, 0);
    }, true);
    // a note's flag on the strip: its note in the Notes panel (the studio opens it there)
    document.addEventListener('click', (e) => {
      if (stack() && e.target.closest('.mn-flag, .mn-flag-span')) setTimeout(() => { autoOpen = false; show('panel'); tbButtons(); }, 0);
    }, true);
    // a tap on the strip or the picture answers at once (the tick is the fallback)
    document.addEventListener('pointerup', (e) => { if (stack() && e.target.closest('.glm-tlwrap, .glm-view, .glm-top .glm-xbtn')) setTimeout(tick, 30); }, true);
    // a double tap (or a double click) on a layer — its clip, the picture, its name, its row in Layers — opens its
    // Properties; a single one only picks it. Timed from the pointer, so a finger and a mouse alike; a drag is not a tap
    let tapAt = null, lastTap = null;
    const LAYER = '.glm-layer, .glm-view, .lab-track-label, #layer-list .ve-nav-row, #layer-list [data-id]';
    document.addEventListener('pointerdown', (e) => { tapAt = stack() && mode() === 'edit' && e.target.closest(LAYER) ? { x: e.clientX, y: e.clientY } : null; }, true);
    document.addEventListener('pointerup', (e) => {
      const t = tapAt; tapAt = null;
      if (!t || Math.hypot(e.clientX - t.x, e.clientY - t.y) > 6) { lastTap = null; return; }
      const now = performance.now();
      if (lastTap && now - lastTap.t < 380 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 24) {
        lastTap = null;
        setTimeout(() => { const pg = api(); if (mode() === 'edit' && pg && pg.selected && pg.selected() != null) { show('panel'); tbButtons(); } }, 60);
      } else lastTap = { x: e.clientX, y: e.clientY, t: now };
    }, true);
    tbButtons();
  }

  // zoom with the time under the finger (or the pointer) kept where it is
  function setPPS(next, anchorX) {
    next = Math.max(20, Math.min(240, next)); if (Math.abs(next - PPS) < 0.5) return;
    const edit = mode() === 'edit', sc = document.querySelector(edit ? '.cl-lanes, .glm-tlwrap' : '.hl-tl'), bar = document.querySelector(edit ? '.glm-bar' : '.hl-ruler');
    let f = null;
    if (sc && bar && anchorX != null) { const r = bar.getBoundingClientRect(); f = (anchorX - r.left) / Math.max(1, r.width); }
    PPS = next; store.set('glm-chat-pps', String(Math.round(PPS)));
    measure();
    if (sc && bar && f != null) { const r2 = bar.getBoundingClientRect(); sc.scrollLeft += r2.left + f * r2.width - anchorX; }
  }
  document.addEventListener('wheel', (e) => {
    if (!e.ctrlKey || !stack() || !e.target.closest('.glm-tlwrap, .hl-tl')) return;
    e.preventDefault(); setPPS(PPS * Math.exp(-e.deltaY * 0.01), e.clientX);
  }, { passive: false, capture: true });
  let pinch = null;
  document.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 2 || !stack() || !e.target.closest('.glm-tlwrap, .hl-tl')) return;
    const [a, b] = e.touches;
    pinch = { d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1, pps: PPS };
  }, { passive: true, capture: true });
  document.addEventListener('touchmove', (e) => {
    if (!pinch || e.touches.length !== 2) return;
    e.preventDefault();
    const [a, b] = e.touches;
    setPPS(pinch.pps * (Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) / pinch.d), (a.clientX + b.clientX) / 2);
  }, { passive: false, capture: true });
  document.addEventListener('touchend', (e) => { if (e.touches.length < 2) pinch = null; }, { capture: true });
  window.addEventListener('resize', apply);

  // the shape before the page paints (no jump), then the rest once the engine's page is up
  shape(window.GL_LAB_PROJECT);
  apply();
  (function start() {
    const pg = api();
    if (!document.querySelector('.lab-rail') || !window.RV || !pg || !pg.ready) { setTimeout(start, 120); return; }
    started = true;
    shape(window.GL_LAB_PROJECT);
    let last = mode();
    new MutationObserver(() => {
      const m = mode(); if (m === last) return; last = m;
      document.querySelectorAll('.rv-edit-toolbar [data-cl-tb=panel] span').forEach((s) => { s.textContent = LABEL[m]; });
      if (compact) show(firstTab(m));
    }).observe(B, { attributes: true, attributeFilter: ['class'] });
    // a rebuild, or another project on the page (its shape may differ)
    window.addEventListener('rv:remount', () => setTimeout(() => { shape(window.GL_LAB_PROJECT); addExpand(); restoreSplit(); measure(); }, 0));
    addExpand(); addSplit();
    B.classList.toggle('cl-nostrip', !window.RV_STRIPS);
    const fitText = !(window.CSS && CSS.supports && CSS.supports('field-sizing', 'content'));
    setInterval(() => {   // the inspector rebuilds its rows on every pick
      if (!compact) return; pictureFields();
      if (fitText) document.querySelectorAll('.lab-inspector textarea.mi-text').forEach((t) => { if (document.activeElement === t) return; t.style.height = 'auto'; t.style.height = Math.min(98, Math.max(30, t.scrollHeight + 2)) + 'px'; });
    }, 300);
    delete B.dataset.clTab;
    apply();
  })();

  return {
    // the page's news: the box's height in the chat, full screen or not, the host able to go full screen or not
    set(next = {}) {
      if (next.height != null && +next.height > 0) S.height = +next.height;
      if (next.full != null) S.full = !!next.full;
      if ('onExpand' in next) S.onExpand = typeof next.onExpand === 'function' ? next.onExpand : null;
      apply();
    },
    compact: () => compact,   // the mobile editor (up to 900 px), or the whole-window studio
  };
}
