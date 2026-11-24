/* (chatswitch) Draft 3D | Final 3D for a film's 3D Scene in the preview's player bar (.glm-transport, after Loop, before the time): the
   app's own control (Player.jsx WorldFinalToggle: one button, its dot green under Final, the trace's samples before it), on every studio
   host (the page `greenlight-motion build` writes, a chat's page, a shared link, a comparison). Only a film with a 3D Scene has it; a
   2D film's page is as it was (no control, no class, no timer).
   Owner, 2026-11-15: "same logic as in app. Draft in preview play. Final will show only if switcher is set to final and only on pause."
   Owner, 2026-11-24 (the lab html/INTERFACE/standalone-3d-switch-lab, "A and 1"): in the preview, opening in Draft, the PREVIEW's only.
   Draft: the live picture, playing and paused. Final: playing still shows Draft; on pause the frame path traces in place (the app's
   start badge over the preview, then its samples beside the toggle); a seek, a step or an edit goes back to Draft and traces again once
   it settles (world3dLayer.js: the app's own Final, nothing of its own here). What renders is not this toggle's: Render MP4, renderVideo,
   stills and the Final cap follow the film's own mode, or the Render pane's 3D (PlayerPage.jsx), which is what the host hears of
   (`glm:world3d`). It opens in Draft whatever the film says, and nothing is kept: a rebuild of the page (a layer added, another version
   mounted) keeps the choice made on this page; a page opened again starts in Draft (what the switch kept before, `<storeKey>-3d` in this
   browser, is removed). */
import { traceProgressText } from '../worldMode.js';

// what the switch kept per film before it was the preview's own (storeKey + '-3d'): never read again, removed when the film opens
const OLD_KEY = (storeKey) => `${storeKey || 'glm-studio'}-3d`;

export function install() {
  const $ = (s) => document.querySelector(s);
  const api = () => window.GreenLightMotion?.page;
  let box = null, btn = null, label = null, status = null, badge = null, mode = null, own = null, loading = null, ticking = false, timer = 0;
  const shown = {};   // what the DOM says now: written only when it changes

  function build() {
    box = document.createElement('span'); box.className = 'rv-w3d'; box.dataset.w3dSwitch = '';
    status = document.createElement('span'); status.className = 'rv-w3d-status'; status.setAttribute('aria-live', 'polite');
    btn = document.createElement('button'); btn.type = 'button'; btn.className = 'rv-w3d-toggle'; btn.dataset.w3d = 'toggle';
    btn.title = 'Draft 3D is the fast preview. Final 3D path traces this frame on pause, the way the render will look.';
    btn.innerHTML = '<i aria-hidden="true"></i>';
    label = document.createElement('span'); btn.append(label);
    btn.onclick = (e) => { e.stopPropagation(); choose(mode === 'final' ? 'draft' : 'final'); };
    box.append(status, btn);
    badge = document.createElement('div'); badge.className = 'rv-w3d-load'; badge.setAttribute('role', 'status'); badge.hidden = true;
    badge.innerHTML = '<div class="rv-w3d-load-meta"><span>Starting Final 3D</span><span class="rv-w3d-load-step">Preparing the path tracer</span></div><div class="rv-w3d-load-bar"><i></i></div>';
  }
  // in the player bar before the time (the page's Transport keeps its own children, so the toggle stays where it is put); the start
  // badge over the picture, at its top
  function place() {
    const bar = $('.glm-transport');
    const time = bar?.querySelector(':scope > .glm-time');
    if (bar && box && (box.parentNode !== bar || box.nextElementSibling !== time)) bar.insertBefore(box, time || null);
    const view = $('.glm-view'), frame = $('.glm-frame');
    if (badge && view && badge.parentNode !== view) view.append(badge);
    if (badge && view && frame && !badge.hidden) {
      const fr = frame.getBoundingClientRect(), vr = view.getBoundingClientRect();
      badge.style.top = Math.max(8, fr.top - vr.top + 10) + 'px';
      badge.style.left = (fr.left - vr.left + fr.width / 2) + 'px';
    }
  }
  function render() {
    if (!btn) return;
    const on = mode === 'final', busy = !!api()?.world3d?.rendering?.();
    if (shown.on !== on) {
      shown.on = on;
      btn.setAttribute('aria-pressed', String(on));
      btn.classList.toggle('on', on);
      label.textContent = on ? 'Final 3D' : 'Draft 3D';
    }
    if (shown.busy !== busy) { shown.busy = busy; btn.disabled = busy; }   // an MP4 under way traces its own frames meanwhile
  }
  function choose(m) {
    const w = api()?.world3d;
    if (!w?.has || w.rendering?.() || m === mode) return;
    mode = m;
    w.setPreview(m);
    if (m === 'draft' && status) { status.textContent = ''; status.dataset.done = '0'; }   // the trace's words go at once
    render(); tick();
  }
  // the trace's samples beside the toggle while it traces on pause (the app's player bar; shortened where the bar is short), the start
  // badge over the picture
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const w = api()?.world3d;
      const asked = w && mode === 'final' ? await w.status() : null;
      // (a status read while the toggle went back to Draft is not shown: a busy GPU answers late)
      const s = mode === 'final' ? asked : null;
      const short = ($('.glm-transport')?.clientWidth || 0) < 560;
      const text = s && short ? (s.done ? `${Number(s.seconds || 0).toFixed(1)} s` : `${s.spp}/${s.target} spp`) : traceProgressText(s);
      if (status && status.textContent !== text) status.textContent = text;
      const done = s?.done ? '1' : '0';
      if (status && status.dataset.done !== done) status.dataset.done = done;
      const hide = !(mode === 'final' && loading?.stage === 'final');
      if (badge && badge.hidden !== hide) { badge.hidden = hide; if (!hide) place(); }
      render();
    } catch { /* the page is being rebuilt: the next tick reads the new one */ }
    ticking = false;
  }
  const onResize = () => { if (badge && !badge.hidden) place(); };
  // the film on the page (at start, and after a rebuild or another project mounted): its Scene, the toggle in Draft (or what was chosen
  // on this page), the preview told
  function attach() {
    const w = api()?.world3d;
    own = w?.has ? w.own : null;
    document.body.classList.toggle('rv-w3d-on', !!own);   // the chat layout's play row on a phone makes room for it (chat.css)
    if (!own) {
      box?.remove(); badge?.remove();
      clearInterval(timer); timer = 0; window.removeEventListener('resize', onResize);
      return;
    }
    if (!box) build();
    mode = mode || 'draft';
    w.setPreview(mode);
    try { localStorage.removeItem(OLD_KEY(window.RV?.storeKey || window.RV_CONFIG?.storeKey)); } catch { /* a private window */ }
    if (!loading) { loading = { stage: null }; w.watchLoad((l) => { loading = l || { stage: null }; tick(); }); }
    if (!timer) { timer = setInterval(tick, 400); window.addEventListener('resize', onResize); }
    shown.on = shown.busy = undefined;
    place(); render(); tick();
  }
  window.addEventListener('rv:remount', () => setTimeout(attach, 0));
  (function start() {
    const pg = api();
    if (!pg?.ready || !window.RV?.ready?.() || !$('.glm-transport')) { setTimeout(start, 120); return; }
    attach();
  })();
}
