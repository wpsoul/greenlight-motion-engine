/* The app's colour field (frontend/src/components/ColorPicker.jsx, withAlpha), ported for the lab inspector.
   The row: a dot that opens the panel, the value you can type (hex, or rgba() once it is see-through), and the
   screen eyedropper. The panel: saturation/brightness, hue, OPACITY, the film's own colours (round, like the app's
   project tokens) above the stock palette, then the value box with eyedropper and copy. Opacity lives in the colour
   itself, as the app stores it: #rrggbb at full, rgba(r, g, b, a) below. LabColor.field({label, get, set, tokens}). */
export function install(STUDIO) {
  const PRESETS = ['#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16', '#22c55e', '#10b981', '#14b8a6', '#06b6d4', '#0ea5e9',
    '#3b82f6', '#6366f1', '#8b5cf6', '#a855f7', '#d946ef', '#ec4899', '#f43f5e', '#78716c', '#6b7280', '#94a3b8'];
  const icon = (d, s) => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const PIPETTE = '<path d="m2 22 1-1h3l9-9"/><path d="M3 21v-3l9-9"/><path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z"/>';
  const COPY = '<rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/><path d="M16 4h2a2 2 0 0 1 2 2v4"/><path d="M21 14H11"/><path d="m15 10-4 4 4 4"/>';
  const canDrop = () => typeof window.EyeDropper === 'function';
  // ── the app's conversions, verbatim ──
  function hexToHsva(hex) {
    const h = hex.replace('#', ''), r = parseInt(h.slice(0, 2), 16) / 255, g = parseInt(h.slice(2, 4), 16) / 255, b = parseInt(h.slice(4, 6), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min, s = max === 0 ? 0 : d / max, v = max;
    let hue = 0;
    if (d !== 0) { if (max === r) hue = ((g - b) / d + (g < b ? 6 : 0)) / 6; else if (max === g) hue = ((b - r) / d + 2) / 6; else hue = ((r - g) / d + 4) / 6; }
    return { h: hue * 360, s, v, a: 1 };
  }
  function hsvaToHex(h, s, v) {
    const hh = h / 60, c = v * s, x = c * (1 - Math.abs(hh % 2 - 1)), m = v - c;
    let r = 0, g = 0, b = 0;
    if (hh >= 0 && hh < 1) { r = c; g = x; } else if (hh < 2) { r = x; g = c; } else if (hh < 3) { g = c; b = x; } else if (hh < 4) { g = x; b = c; } else if (hh < 5) { r = x; b = c; } else { r = c; b = x; }
    const toHex = n => Math.round((n + m) * 255).toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }
  const VALID = /^(#[0-9a-f]{3}|#[0-9a-f]{6}|#[0-9a-f]{8}|rgba?\([^)]+\))$/i;
  function parseColor(value) {
    if (!value || typeof value !== 'string') return { hex: '#ffffff', alpha: 1 };
    const v = value.trim();
    if (/^#[0-9a-f]{8}$/i.test(v)) return { hex: '#' + v.slice(1, 7).toLowerCase(), alpha: parseInt(v.slice(7, 9), 16) / 255 };
    if (/^#[0-9a-f]{6}$/i.test(v)) return { hex: v.toLowerCase(), alpha: 1 };
    if (/^#[0-9a-f]{3}$/i.test(v)) { const n = v.slice(1); return { hex: `#${n[0]}${n[0]}${n[1]}${n[1]}${n[2]}${n[2]}`.toLowerCase(), alpha: 1 }; }
    const m = v.match(/^rgba?\(([^)]+)\)$/i);
    if (m) {
      const p = m[1].split(',').map(s => s.trim()), ch = i => Math.round(Math.max(0, Math.min(255, +p[i] || 0))).toString(16).padStart(2, '0');
      return { hex: `#${ch(0)}${ch(1)}${ch(2)}`, alpha: p.length >= 4 ? Math.max(0, Math.min(1, +p[3] || 0)) : 1 };
    }
    return { hex: '#ffffff', alpha: 1 };
  }
  function formatOutput(hex, alpha) {
    if (alpha >= 0.999) return hex;
    return `rgba(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)}, ${alpha.toFixed(3)})`;
  }
  const rgbaOf = (hex, a) => `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${a})`;
  const make = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  let openField = null;

  function field({ label = 'Colour', get, set, tokens = () => [] }) {
    const wrap = make('div', 'cp-wrap');
    wrap.innerHTML = `<div class="cp-swatch-btn"><button type="button" class="cp-swatch-open" aria-label="Open colour picker"><span class="cp-swatch"></span></button>`
      + `<input type="text" class="cp-swatch-label" spellcheck="false" autocomplete="off" aria-label="${label} value"></div>`
      + (canDrop() ? `<button type="button" class="cp-inline-pipette" title="Pick colour from screen" aria-label="Pick colour from screen">${icon(PIPETTE, 12)}</button>` : '');
    const swatch = wrap.querySelector('.cp-swatch'), text = wrap.querySelector('.cp-swatch-label'), opener = wrap.querySelector('.cp-swatch-open');
    let hsva = { ...hexToHsva('#ffffff'), a: 1 }, draft = null, pop = null, quietUntil = 0, queued = null, picking = false, gone = 0;
    const hex = () => hsvaToHex(hsva.h, hsva.s, hsva.v), shown = () => formatOutput(hex(), hsva.a);
    // one write per frame: every write re-renders the engine page
    function emit() {
      quietUntil = performance.now() + 300;   // the page answers a frame later; don't read the old value back meanwhile
      const first = queued == null; queued = shown();
      if (first) requestAnimationFrame(() => { const v = queued; queued = null; set(v); });
      paint();
    }
    function paint() {
      swatch.style.background = rgbaOf(hex(), hsva.a); opener.title = shown();
      if (draft === null && document.activeElement !== text) text.value = shown();
      if (!pop) return;
      const q = s => pop.querySelector(s);
      q('.cp-sv').style.background = `hsl(${hsva.h}, 100%, 50%)`;
      Object.assign(q('.cp-sv-cursor').style, { left: hsva.s * 100 + '%', top: (1 - hsva.v) * 100 + '%' });
      q('.cp-hue-bar .cp-bar-cursor').style.left = hsva.h / 360 * 100 + '%';
      q('.cp-alpha-gradient').style.background = `linear-gradient(to right, transparent, ${hex()})`;
      q('.cp-alpha-bar .cp-bar-cursor').style.left = hsva.a * 100 + '%';
      q('.cp-alpha-bar').setAttribute('aria-valuenow', String(Math.round(hsva.a * 100)));
      pop.querySelectorAll('.cp-preset-swatch').forEach(b => b.classList.toggle('active', parseColor(b.dataset.c).hex === hex()));
      const box = q('.cp-hex-input'); if (document.activeElement !== box) box.value = shown();
    }
    // the value from outside (another source, the agent, Undo): keep the hue while the colour is the same
    function sync() {
      if (performance.now() < quietUntil || queued != null) return;
      const { hex: h, alpha } = parseColor(get());
      if (h !== hex() || Math.abs(hsva.a - alpha) >= 0.005) hsva = { ...hexToHsva(h), a: alpha };
      paint();
    }
    function apply(raw, keepAlpha) {
      const p = parseColor(raw), carries = /^#[0-9a-f]{8}$/i.test(raw.trim()) || /^rgba\(/i.test(raw.trim());
      hsva = { ...hexToHsva(p.hex), a: keepAlpha && !carries ? hsva.a : p.alpha }; emit();
    }
    function typed(e) {
      draft = e.target.value;
      if (VALID.test(draft.trim())) { const p = parseColor(draft); hsva = { ...hexToHsva(p.hex), a: p.alpha }; emit(); }
    }
    async function drop() {
      if (!canDrop() || picking) return; picking = true; wrap.classList.add('picking');
      try { const r = await new window.EyeDropper().open(); if (r?.sRGBHex) { hsva = { ...hexToHsva(r.sRGBHex), a: hsva.a }; emit(); } }
      catch (err) { if (err?.name !== 'AbortError') console.warn('EyeDropper failed', err); }
      finally { picking = false; wrap.classList.remove('picking'); }
    }
    text.addEventListener('input', typed);
    text.addEventListener('blur', () => { draft = null; paint(); });
    text.addEventListener('keydown', e => { if (e.key === 'Enter') text.blur(); else if (e.key === 'Escape') { draft = null; text.blur(); } });
    opener.addEventListener('click', () => (pop ? close() : open()));
    wrap.querySelector('.cp-inline-pipette')?.addEventListener('click', drop);

    function dragOn(el, fn) {
      el.addEventListener('pointerdown', e => {
        if (e.button !== 0) return; e.preventDefault();
        const r = el.getBoundingClientRect(); fn(e, r);
        const mv = ev => fn(ev, r), up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); };
        window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
      });
    }
    const clamp = v => Math.max(0, Math.min(1, v));
    function open() {
      if (openField && openField !== api) openField.close();
      const film = [...new Set(tokens().map(c => String(c)).filter(c => VALID.test(c)))];
      pop = make('div', 'cp-portal');
      pop.innerHTML = `<div class="cp-popover cp-popover-end" role="dialog" aria-label="${label}">`
        + `<div class="cp-sv"><div class="cp-sv-white"></div><div class="cp-sv-black"></div><div class="cp-sv-cursor"></div></div>`
        + `<div class="cp-bar cp-hue-bar" role="slider" aria-label="Hue"><div class="cp-bar-cursor"></div></div>`
        + `<div class="cp-bar cp-alpha-bar" role="slider" aria-label="Opacity" aria-valuemin="0" aria-valuemax="100" title="Opacity"><div class="cp-alpha-gradient"></div><div class="cp-bar-cursor"></div></div>`
        + (film.length ? `<div class="cp-tokens"><div class="cp-presets">${film.map(c => `<button type="button" class="cp-preset-swatch cp-token-swatch" data-c="${c}" data-keep="0" style="background:${c}" title="This film · ${c}" aria-label="Use ${c} from this film"></button>`).join('')}</div></div>` : '')
        + `<div class="cp-presets">${PRESETS.map(c => `<button type="button" class="cp-preset-swatch" data-c="${c}" data-keep="1" style="background:${c}" title="${c}" aria-label="Use colour ${c}"></button>`).join('')}</div>`
        + `<div class="cp-inputs"><input type="text" class="cp-hex-input" spellcheck="false" autocomplete="off" aria-label="${label} value">`
        + `<button type="button" class="cp-tool-btn" data-t="drop" ${canDrop() ? '' : 'disabled'} title="Pick colour from screen" aria-label="Pick colour from screen">${icon(PIPETTE, 14)}</button>`
        + `<button type="button" class="cp-tool-btn" data-t="copy" title="Copy colour" aria-label="Copy colour to clipboard">${icon(COPY, 14)}</button></div></div>`;
      document.body.append(pop); wrap.classList.add('cp-open'); openField = api;
      dragOn(pop.querySelector('.cp-sv'), (e, r) => { hsva = { ...hsva, s: clamp((e.clientX - r.left) / r.width), v: clamp(1 - (e.clientY - r.top) / r.height) }; emit(); });
      dragOn(pop.querySelector('.cp-hue-bar'), (e, r) => { hsva = { ...hsva, h: clamp((e.clientX - r.left) / r.width) * 360 }; emit(); });
      dragOn(pop.querySelector('.cp-alpha-bar'), (e, r) => { hsva = { ...hsva, a: clamp((e.clientX - r.left) / r.width) }; emit(); });
      pop.querySelectorAll('.cp-preset-swatch').forEach(b => b.addEventListener('click', () => apply(b.dataset.c, b.dataset.keep === '1')));
      const box = pop.querySelector('.cp-hex-input');
      box.addEventListener('input', typed); box.addEventListener('blur', () => { draft = null; paint(); });
      box.addEventListener('keydown', e => { if (e.key === 'Enter') box.blur(); });
      pop.querySelector('[data-t=drop]').addEventListener('click', drop);
      pop.querySelector('[data-t=copy]').addEventListener('click', e => { const b = e.currentTarget; navigator.clipboard?.writeText(shown()).then(() => { b.classList.add('cp-copied'); b.title = 'Copied!'; setTimeout(() => { b.classList.remove('cp-copied'); b.title = 'Copy colour'; }, 1200); }).catch(() => {}); });
      place(); requestAnimationFrame(place);
      // pointerdown, not mousedown: the engine's timeline cancels the press on its bars, and then no mousedown follows
      document.addEventListener('pointerdown', outside, true); window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
      // the inspector rebuilds its rows (another layer, a source switch): a panel whose row left the page closes with it
      gone = setInterval(() => { if (!wrap.isConnected) close(); }, 250);
      paint();
    }
    // fixed beside the row, right edges aligned (the inspector is on the right); up when there's no room below
    function place() {
      if (!pop) return;
      const r = wrap.getBoundingClientRect(), w = pop.offsetWidth || 242, h = pop.offsetHeight || 320, gap = 5;
      const up = window.innerHeight - r.bottom < h + gap + 8 && r.top > window.innerHeight - r.bottom;
      Object.assign(pop.style, { position: 'fixed', zIndex: 100020, left: Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w)) + 'px',
        top: up ? '' : Math.min(r.bottom + gap, window.innerHeight - h - 8) + 'px', bottom: up ? window.innerHeight - r.top + gap + 'px' : '' });
    }
    function outside(e) { if (wrap.contains(e.target) || pop?.contains(e.target)) return; close(); }
    function close() {
      if (!pop) return; pop.remove(); pop = null; clearInterval(gone); wrap.classList.remove('cp-open'); if (openField === api) openField = null;
      document.removeEventListener('pointerdown', outside, true); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true);
    }
    const api = { el: wrap, sync, close, open, isOpen: () => !!pop };
    wrap.labColor = api;
    sync();
    return api;
  }
  window.LabColor = { field, parseColor, formatOutput };
}
