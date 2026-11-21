/* (chatswitch) Draft | Final for a film's 3D Scene, at the end of the Edit toolbar: the app's own Draft 3D / Final 3D (the player bar's
   WorldFinalToggle, the Render dialog's 3D renderer), on every studio host (a chat's page, a shared link, a page of one's own). Only a
   film with a 3D Scene has it; a 2D film's page is as it was.
   Owner, 2026-11-15: "same logic as in app. Draft in preview play. Final will show only if switcher is set to final and only on pause."
   Draft: the live picture, playing and paused; Render MP4 renders Draft. Final: playing still shows Draft; on pause the frame path
   traces in place (the app's start badge over the preview, then its samples beside the switch); a seek, a step or an edit goes back to
   Draft and traces again once it settles (world3dLayer.js: the app's own Final, nothing of its own here); Render MP4 renders Final, and
   a host's Final cap asks first. It opens on what the film says (its Scene's render.mode: a chat's script is Draft unless it says
   Final), and the viewer's choice is kept per film (beside the studio's own storage: storeKey + '-3d'). A change is told to the host
   page as the window event `glm:world3d` ({ mode, own }). */
import { pickWorldMode, worldModeKey, traceProgressText } from '../worldMode.js';

export function install() {
  const $ = (s) => document.querySelector(s);
  const api = () => window.GreenLightMotion?.page;
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* a private window: kept for this page only */ } },
  };
  const key = () => worldModeKey(window.RV?.storeKey || window.RV_CONFIG?.storeKey);
  let box = null, seg = null, status = null, badge = null, mode = null, own = null, loading = null, ticking = false;

  function build() {
    box = document.createElement('span'); box.className = 'rv-w3d'; box.dataset.w3dSwitch = '';
    status = document.createElement('span'); status.className = 'rv-w3d-status'; status.setAttribute('aria-live', 'polite');
    seg = document.createElement('span'); seg.className = 'rv-w3d-seg'; seg.setAttribute('role', 'group'); seg.setAttribute('aria-label', '3D: Draft or Final');
    for (const [m, label, title] of [
      ['draft', 'Draft 3D', 'Draft 3D: the fast picture, playing and paused. Render MP4 renders it.'],
      ['final', 'Final 3D', 'Final 3D: playing shows Draft; on pause the frame is path traced, the way Render MP4 renders it.'],
    ]) {
      const b = document.createElement('button'); b.type = 'button'; b.dataset.w3d = m; b.title = title;
      b.innerHTML = m === 'final' ? '<i aria-hidden="true"></i>' : '';
      b.append(document.createTextNode(label));
      b.onclick = (e) => { e.stopPropagation(); choose(m); };
      seg.append(b);
    }
    box.append(status, seg);
    badge = document.createElement('div'); badge.className = 'rv-w3d-load'; badge.setAttribute('role', 'status'); badge.hidden = true;
    badge.innerHTML = '<div class="rv-w3d-load-meta"><span>Starting Final 3D</span><span class="rv-w3d-load-step">Preparing the path tracer</span></div><div class="rv-w3d-load-bar"><i></i></div>';
  }
  // the Edit toolbar is rebuilt on every pick (lab.js renderActs): the switch goes back at its end at once, before it paints
  function place() {
    const bar = $('.rv-edit-toolbar');
    if (bar && box && (box.parentNode !== bar || bar.lastElementChild !== box)) bar.append(box);
    if (bar && bar.dataset.w3dObs !== '1') { bar.dataset.w3dObs = '1'; new MutationObserver(place).observe(bar, { childList: true }); }
    const view = $('.glm-view'), frame = $('.glm-frame');
    if (badge && view && badge.parentNode !== view) view.append(badge);
    if (badge && view && frame) {   // over the picture, at its top
      const fr = frame.getBoundingClientRect(), vr = view.getBoundingClientRect();
      badge.style.top = Math.max(8, fr.top - vr.top + 10) + 'px';
      badge.style.left = (fr.left - vr.left + fr.width / 2) + 'px';
    }
  }
  function render() {
    if (!seg) return;
    const busy = !!api()?.world3d?.rendering?.();
    seg.querySelectorAll('button').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.w3d === mode));
      b.classList.toggle('on', b.dataset.w3d === mode);
      b.disabled = busy;
    });
  }
  function choose(m) {
    if (!api()?.world3d?.has || api().world3d.rendering?.() || m === mode) return;
    mode = m;
    store.set(key(), m);
    api().world3d.set(m);
    render(); tick();
    // the host hears of it once the page plays, renders and draws stills in that mode (its API shows it after the page's next render)
    const t0 = performance.now();
    (function told() {
      if (mode !== m) return;
      if (api()?.world3d?.mode === m || performance.now() - t0 > 3000) window.dispatchEvent(new CustomEvent('glm:world3d', { detail: { mode, own } }));
      else setTimeout(told, 30);
    })();
  }
  // the trace's samples beside the switch while it traces on pause (the app's player bar), the start badge over the picture
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const w = api()?.world3d;
      const s = w && mode === 'final' ? await w.status() : null;
      const text = traceProgressText(s);
      if (status && status.textContent !== text) status.textContent = text;
      if (status) status.dataset.done = s?.done ? '1' : '0';
      if (badge) { badge.hidden = !(mode === 'final' && loading?.stage === 'final'); if (!badge.hidden) place(); }
      render();
    } catch { /* the page is being rebuilt: the next tick reads the new one */ }
    ticking = false;
  }
  // the film on the page (at start, and after a rebuild or another project mounted): its Scene, its mode, the switch
  function attach() {
    const w = api()?.world3d;
    own = w?.has ? w.own : null;
    mode = pickWorldMode({ stored: own ? store.get(key()) : null, own });
    if (!mode) { box?.remove(); badge?.remove(); return; }
    if (!box) build();
    w.set(mode);
    if (!loading) { loading = { stage: null }; w.watchLoad((l) => { loading = l || { stage: null }; tick(); }); }
    place(); render(); tick();
  }
  window.addEventListener('rv:remount', () => setTimeout(attach, 0));
  window.addEventListener('resize', () => { if (badge && !badge.hidden) place(); });
  (function start() {
    const pg = api();
    if (!pg?.ready || !window.RV?.ready?.() || !$('.rv-edit-toolbar')) { setTimeout(start, 120); return; }
    attach();
    setInterval(() => { if (mode) tick(); }, 400);
  })();
}
