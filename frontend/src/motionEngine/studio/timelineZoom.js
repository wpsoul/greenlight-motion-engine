// The timeline's scale, one for every layout: ctrl / ⌘ + wheel or a pinch zooms with the time under the pointer kept where
// it is (videoEditor/Timeline.jsx's gesture), the lanes scroll sideways, and the view follows the playhead while it plays.
// Up to 900 px wide (chat.js lays that out, through layoutNarrow) the strip starts at 100 px a second, kept between visits.
// Wider it starts with the whole film in one width, the page as it always was: no scroller and no frame loop until someone
// zooms, and zooming all the way out goes back to that. Zoomed: body.rv-tlzoom, the lanes' widths in --rv-barw, --rv-hlw
// and --rv-hlvw (highlight.css). Edit's lanes are `.cl-lanes`, Notes and Highlight's are `.hl-tl`.
const B = document.body;
const MAX_PPS = 240, NARROW_MIN_PPS = 20, LEAD = 48, IDLE = 1200, GLIDE = 320, EDGE = 28;
const VARS = ['--rv-barw', '--rv-hlw', '--rv-hlvw'];
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* a private window */ } },
};

export function install() {
  const api = () => window.GreenLightMotion && window.GreenLightMotion.page;
  const mode = () => (/\brv-mode-(\w+)/.exec(B.className) || [])[1] || 'edit';
  const stack = () => B.classList.contains('cl-stack');
  // the element that scrolls the clips sideways: `.cl-lanes` (inside `.glm-tlwrap`, which does not scroll — a selector
  // list in querySelector returns the first in PAGE order, i.e. the wrapper), or Notes / Highlight's `.hl-tl`
  const lanesOf = (edit) => (edit ? document.querySelector('.cl-lanes') || document.querySelector('.glm-tlwrap') : document.querySelector('.hl-tl'));
  const barOf = (edit) => document.querySelector(edit ? '.glm-bar' : '.hl-ruler');
  let narrow = (() => { const v = +store.get('glm-chat-pps'); return v >= NARROW_MIN_PPS && v <= MAX_PPS ? v : 100; })();
  let wide = null;   // px a second; null = the whole film in one width
  const zoomed = () => !stack() && wide != null;
  const live = () => stack() || wide != null;

  // the px a second that fit the whole film in the wide layout's lanes
  function fitted() {
    const pg = api(), hl = document.querySelector('.hl-tl'), lab = hl && hl.querySelector('.hl-lab');
    const box = hl && hl.clientWidth ? hl : document.querySelector('.glm-tlwrap');
    if (!box || !pg || !(pg.duration > 0)) return 0;
    const cs = getComputedStyle(box), pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    return (box.clientWidth - pad - (box === hl && lab ? lab.offsetWidth : 0)) / pg.duration;
  }

  // Edit's timeline: only the lanes scroll sideways — the bar (the ruler, the rows, the playhead) in a scroller of its
  // own, so the toolbar, the names column and their head stay put; undone at the whole-film width
  function lanes() {
    B.classList.toggle('rv-tlzoom', zoomed());
    wake();
    const tl = document.querySelector('#app .glm-tlwrap'); if (!tl) return;
    let wrap = tl.querySelector(':scope > .cl-lanes');
    const bar = tl.querySelector('.glm-bar'), rows = tl.querySelector('.glm-rows'), top = rows ? rows.scrollTop : 0;
    if (live()) {
      if (bar && bar.parentNode === tl) { if (!wrap) { wrap = document.createElement('div'); wrap.className = 'cl-lanes'; } tl.insertBefore(wrap, bar); wrap.append(bar); }
    } else if (wrap) { if (bar && bar.parentNode === wrap) tl.insertBefore(bar, wrap); wrap.remove(); }
    if (rows && rows.scrollTop !== top) rows.scrollTop = top;   // moving the bar loses it
  }
  function layoutWide() {
    lanes();
    const pg = api();
    if (!zoomed() || !pg) { VARS.forEach((v) => B.style.removeProperty(v)); return; }
    const px = Math.round(pg.duration * wide);
    B.style.setProperty('--rv-barw', px + 'px');
    const hl = document.querySelector('.hl-tl'), lab = hl && hl.querySelector('.hl-lab');
    if (hl && hl.clientWidth) {
      const cs = getComputedStyle(hl), pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
      B.style.setProperty('--rv-hlw', (lab ? lab.offsetWidth : 0) + px + 'px');
      B.style.setProperty('--rv-hlvw', hl.clientWidth - pad + 'px');
    }
  }
  const zoom = { pps: () => narrow, lanes, layoutNarrow: null };
  const layout = () => (stack() ? zoom.layoutNarrow && zoom.layoutNarrow() : layoutWide());
  const refit = () => { if (stack() || wide == null) return; if (wide <= fitted() * 1.001) wide = null; layoutWide(); };

  // zoom with the time under the finger (or the pointer) kept where it is
  function setPPS(next, anchorX) {
    const min = stack() ? NARROW_MIN_PPS : fitted(), now = stack() ? narrow : wide ?? min;
    next = Math.max(min, Math.min(Math.max(min, MAX_PPS), next)); if (!(min > 0) || Math.abs(next / now - 1) < 0.002) return;
    const edit = mode() === 'edit', was = barOf(edit);
    let f = null;
    if (was && anchorX != null) { const r = was.getBoundingClientRect(); f = Math.max(0, Math.min(1, (anchorX - r.left) / Math.max(1, r.width))); }
    if (stack()) { narrow = next; store.set('glm-chat-pps', String(Math.round(next))); } else wide = next <= min * 1.001 ? null : next;
    layout();
    const sc = lanesOf(edit), bar = barOf(edit);   // the bar has only just gone into its scroller
    if (sc && bar && f != null) { const r2 = bar.getBoundingClientRect(); sc.scrollLeft += r2.left + f * r2.width - anchorX; }
  }
  document.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey) || !e.target.closest('.glm-tlwrap, .hl-tl')) return;
    e.preventDefault(); setPPS((stack() ? narrow : wide ?? fitted()) * Math.exp(-e.deltaY * 0.01), e.clientX);
  }, { passive: false, capture: true });
  let pinch = null;
  document.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 2 || !e.target.closest('.glm-tlwrap, .hl-tl')) return;
    const [a, b] = e.touches;
    pinch = { d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1, pps: stack() ? narrow : wide ?? fitted() };
  }, { passive: true, capture: true });
  document.addEventListener('touchmove', (e) => {
    if (!pinch || e.touches.length !== 2) return;
    e.preventDefault();
    const [a, b] = e.touches;
    setPPS(pinch.pps * (Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) / pinch.d), (a.clientX + b.clientX) / 2);
  }, { passive: false, capture: true });
  document.addEventListener('touchend', (e) => { if (e.touches.length < 2) pinch = null; }, { capture: true });

  // a drag that starts on the lanes (scrubbing, a selection, a handle) carries on past the view's edge: the view moves
  // under it, and the part that dragged hears about the time the pointer now stands over
  let press = null;
  document.addEventListener('pointerdown', (e) => {
    const on = zoomed() && e.button === 0 && e.target.closest('.hl-lane, .mn-range-layer, .glm-bar') && !e.target.closest('.glm-layer');
    press = on ? { target: e.target, id: e.pointerId, x0: e.clientX, x: e.clientX, y: e.clientY, alt: e.altKey, moved: false } : null;
  }, true);
  window.addEventListener('pointermove', (e) => {
    if (!press || !e.isTrusted) return;
    press.x = e.clientX; press.y = e.clientY; press.alt = e.altKey; press.moved ||= Math.abs(e.clientX - press.x0) > 4;
  }, true);
  const lift = () => { press = null; };
  window.addEventListener('pointerup', lift, true);
  window.addEventListener('pointercancel', lift, true);

  // ── the timeline follows the playhead while it plays, as GreenLight Dash's does (videoEditor/Timeline.jsx): every
  // frame the view keeps the playhead in sight with lead room at the right edge; it gives way while you scroll it
  // yourself and glides back a moment after you stop. Wide and paused: a playhead moved from elsewhere (a highlight in
  // the list, the other tab) comes into view too.
  const own = new WeakMap();
  let userAt = -1e9, glide = null, running = false, lastMode = null, lastHead = null, reveal = false;
  document.addEventListener('scroll', (e) => {
    const el = e.target;
    if (el instanceof Element && el.matches('.cl-lanes, .hl-tl') && Math.abs(el.scrollLeft - (own.get(el) ?? -1)) > 1) { userAt = performance.now(); glide = null; }
  }, true);
  function wake() { if (!running && live()) { running = true; lastMode = mode(); lastHead = null; requestAnimationFrame(follow); } }
  function follow(now) {
    if (!live()) { running = false; return; }
    requestAnimationFrame(follow);
    const pg = api(), st = pg && pg.ready && pg.state ? pg.state() : null;
    if (!st || !(pg.duration > 0)) return;
    const m = mode(), edit = m === 'edit';
    if (m !== lastMode) { lastMode = m; if (!stack()) { layoutWide(); reveal = true; } }
    const sc = lanesOf(edit), bar = barOf(edit);
    if (!sc || !bar || sc.scrollWidth <= sc.clientWidth + 1) return;
    const put = (x) => { sc.scrollLeft = Math.max(0, x); own.set(sc, sc.scrollLeft); };
    // what covers the lanes' left edge (the names column / Highlight's labels) is not part of the view
    const sr = sc.getBoundingClientRect(), cover = document.querySelector(edit ? '.lab-track-labels' : '.hl-lab');
    const cr = cover && cover.offsetParent ? cover.getBoundingClientRect() : null;
    const gutter = cr && cr.left < sr.left + 8 ? Math.max(0, cr.right - sr.left) : 0;
    if (press) {
      const over = !press.moved ? 0 : press.x > sr.right - EDGE ? press.x - sr.right + EDGE : press.x < sr.left + gutter + EDGE ? press.x - sr.left - gutter - EDGE : 0;
      if (over) {
        put(sc.scrollLeft + Math.max(-30, Math.min(30, over / 3)));
        press.target.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: press.x, clientY: press.y, pointerId: press.id, altKey: press.alt }));
      }
      return;
    }
    if (glide) {
      const k = Math.min(1, (now - glide.t0) / GLIDE), e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      put(glide.from + (glide.to - glide.from) * e); if (k >= 1) glide = null; return;
    }
    const head = st.playhead || 0, moved = !stack() && !st.playing && (reveal || (lastHead != null && head !== lastHead));
    lastHead = head; reveal = false;
    if (!moved && (!st.playing || now - userAt < IDLE)) return;
    const x = bar.getBoundingClientRect().left - sr.left + sc.scrollLeft + head / pg.duration * bar.offsetWidth;
    const left = sc.scrollLeft + gutter, right = sc.scrollLeft + sc.clientWidth;
    const to = x > right - LEAD ? x - sc.clientWidth + LEAD : x < left ? x - gutter - LEAD : null;
    if (to == null) return;
    if (moved) glide = { from: sc.scrollLeft, to: Math.max(0, x - (sc.clientWidth + gutter) / 2), t0: now };
    else if (now - userAt < IDLE + 400 && Math.abs(to - sc.scrollLeft) > sc.clientWidth / 3) glide = { from: sc.scrollLeft, to: Math.max(0, to), t0: now };
    else put(to);
  }

  // after chat.js's own resize listener, which may just have changed the layout
  window.addEventListener('resize', () => requestAnimationFrame(refit));
  window.addEventListener('rv:remount', () => setTimeout(refit, 0));   // a new page: a new bar, and maybe a new length
  return zoom;
}
