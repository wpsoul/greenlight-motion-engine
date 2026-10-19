import { useRef, useState, useEffect, useLayoutEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { requestPointPick, cancelPointPick, subscribePointPick } from './pointPickBroker';

/*
 * Shared editor field primitives for the video editor.
 *
 * These mirror the look & behaviour of the embedded HTML editor's input fields
 * (compact icon-tab number input that you drag to scrub, arrow-key nudging,
 * segmented pill controls, styled selects) — but expressed in the video editor's
 * own plain-CSS world (ve-field-* classes, mint --accent) rather than the
 * Tailwind-scoped .gl-html-editor styles, so there's no cross-coupling.
 *
 * NumberField operates in DISPLAY space: pass the number you want shown and get
 * that same number back from onInput. Callers that store a scaled value (e.g.
 * zoom is 0.1–3 but shown as 10–300%) convert at the call site, exactly like the
 * old `(zoom * 100)` / `v / 100` slider code did.
 */

function parseLeadingNumber(val) {
  const m = String(val).match(/^\s*(-?\d*\.?\d+)/);
  return m ? parseFloat(m[1]) : null;
}

function decimalsForStep(step) {
  const s = String(step);
  return s.includes('.') ? s.split('.')[1].length : 0;
}

/**
 * Modifier ladder shared by scrubbing and arrow nudging: Shift is the coarse
 * gear, Alt the fine one, and the two together the finest — so a field whose
 * step is 1 can still be walked in hundredths without giving up a scrub that
 * crosses its whole range in one gesture. Alt is tested first because
 * Alt+Shift means "finer still", not "coarse".
 */
function stepMultiplier(e) {
  if (e.altKey) return e.shiftKey ? 0.01 : 0.1;
  return e.shiftKey ? 10 : 1;
}

/**
 * Vertical drag-to-scrub. Pointer events so a finger can drag without a hover
 * state and without focusing an <input> (which would open the on-screen
 * keyboard). `arm: true` waits for a 3px move so a click still types; `arm:
 * false` starts immediately — the icon tab and the property label.
 */
function beginVerticalScrub(e, { arm, disabled, startVal, step, clampFn, onInput, onCommit, onEngage, onRelease }) {
  if (disabled) return;
  if (e.button != null && e.button !== 0) return;
  const startY = e.clientY;
  const startX = e.clientX;
  const pointerId = e.pointerId;
  let armed = !arm;

  const engage = () => {
    armed = true;
    onEngage?.();
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
  };
  if (armed) {
    e.preventDefault();
    engage();
  }

  const move = (me) => {
    if (pointerId != null && me.pointerId != null && me.pointerId !== pointerId) return;
    if (!armed) {
      if (Math.abs(me.clientY - startY) < 3 && Math.abs(me.clientX - startX) < 3) return;
      engage();
    }
    if (me.cancelable) me.preventDefault();
    const next = clampFn(startVal + (startY - me.clientY) * step * stepMultiplier(me));
    onInput?.(next);
  };
  const up = (me) => {
    if (pointerId != null && me.pointerId != null && me.pointerId !== pointerId && me.type !== 'pointercancel') return;
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    document.removeEventListener('pointercancel', up);
    if (!armed) return;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    onRelease?.();
    onCommit?.();
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
  document.addEventListener('pointercancel', up);
}

/** Default drag-handle glyph — signals "drag me vertically to adjust". */
function DragHandleIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="8 7 12 3 16 7" />
      <polyline points="8 17 12 21 16 17" />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg className="ve-field-chevron" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

export function FieldLabel({ children, action, onScrubPointerDown, scrubTitle }) {
  return (
    <div className="ve-field-label-row">
      <label
        className={`ve-field-label${onScrubPointerDown ? ' ve-field-label-scrub' : ''}`}
        onPointerDown={onScrubPointerDown}
        title={scrubTitle}
      >
        {children}
      </label>
      {action}
    </div>
  );
}

/**
 * Per-option "differs from its default" dot — the small sibling of the section
 * header's PanelStateDot (same accent dot, same swell-into-a-red-× on hover),
 * one size down so a row of them never competes with the header's.
 *
 * It exists only while the option is off its default, so a panel of dark rows
 * reads as "nothing here has been touched", and clicking one puts that single
 * option back without disturbing the rest of the section.
 */
export function FieldResetDot({ changed, onReset, title = 'Reset to default' }) {
  if (!changed) return null;
  return (
    <button
      type="button"
      className="gl-state-dot gl-state-dot-sm"
      title={title}
      aria-label={title}
      onClick={(e) => { e.stopPropagation(); onReset?.(e); }}
    />
  );
}

/**
 * Section-header info affordance: a small ⓘ whose explanation shows only on
 * hover/focus, so a long paragraph of guidance stops eating panel height.
 *
 * The bubble is body-portaled and position:fixed — the inspector body is
 * `overflow-y: auto`, which per spec clips overflow-x too, so an absolutely
 * positioned bubble would be cropped at the panel edge. Placement is derived
 * from the icon's rect (re-derived on scroll/resize) and flips above when there
 * isn't room below.
 */
export function SectionInfo({ children, label = 'About this section', width = 250 }) {
  const btnRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);

  useLayoutEffect(() => {
    if (!open) { setPos(null); return undefined; }
    const place = () => {
      const el = btnRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const gap = 8;
      const margin = 10;
      const spaceBelow = window.innerHeight - r.bottom - gap - margin;
      const spaceAbove = r.top - gap - margin;
      const openUp = spaceBelow < 120 && spaceAbove > spaceBelow;
      setPos({
        openUp,
        top: r.bottom + gap,
        bottom: window.innerHeight - r.top + gap,
        left: Math.max(margin, Math.min(r.left + r.width / 2 - width / 2, window.innerWidth - width - margin)),
        maxHeight: Math.max(110, openUp ? spaceAbove : spaceBelow),
      });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, width]);

  return (
    <>
      <button
        type="button"
        ref={btnRef}
        className={`ve-section-info${open ? ' is-open' : ''}`}
        aria-label={label}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        // Some section headers toggle collapse when clicked — the ⓘ is a hover
        // affordance only, so it never forwards the click.
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9.5" />
          <path d="M12 11.2v4.8" />
          <path d="M12 7.9h.01" />
        </svg>
      </button>
      {open && pos && createPortal(
        <div
          className="ve-section-info-tip"
          role="tooltip"
          style={{
            position: 'fixed',
            left: pos.left,
            top: pos.openUp ? 'auto' : pos.top,
            bottom: pos.openUp ? pos.bottom : 'auto',
            width,
            maxHeight: pos.maxHeight,
            zIndex: 10001,
          }}
        >
          {children}
        </div>,
        document.body,
      )}
    </>
  );
}

/**
 * Compact numeric field with a draggable icon tab (drag ↕ to scrub; folds away
 * until hover), a property label that is itself a scrub strip (so a tablet can
 * drag without focusing the value and opening the keyboard), arrow-key nudging
 * (Shift ×10, Alt ×0.1, Alt+Shift ×0.01), and min/max clamping.
 *  - value:    display number (already scaled by the caller)
 *  - onInput:  live value during drag / typing / arrows
 *  - onCommit: end of an interaction (drag release, blur, arrow press) — lets the
 *              caller close an undo group, mirroring the old handleSliderEnd.
 *  - precision: decimals the field keeps, independent of `step`. `step` is the
 *              coarse drag/arrow grain (1% per pixel reads right for Position);
 *              precision is how fine a value may BE. Pass precision={2} and the
 *              field accepts a typed 12.35 and shows a 12.35 written by a preview
 *              drag, while a plain scrub still walks in whole units.
 *  - defaultValue: the option's authored default (in the same display space). Pass
 *              it and the label grows a reset dot whenever the value is off it.
 */
export function NumberField({
  label,
  labelAction,
  icon,
  value,
  defaultValue,
  onInput,
  onCommit,
  min = -Infinity,
  max = Infinity,
  step = 1,
  suffix = '',
  precision,
  placeholder,
  title,
  disabled = false,
  // Why the field is greyed out. Defaults to the keyframe case (by far the most
  // common) but callers with another reason — a parent layer owning this
  // property, say — pass their own so the tooltip isn't misleading.
  disabledReason = 'Controlled by keyframes',
}) {
  const decimals = precision != null ? precision : decimalsForStep(step);
  const clamp = useCallback((n) => {
    const c = Math.min(max, Math.max(min, n));
    return Number(c.toFixed(decimals));
  }, [min, max, decimals]);
  // Round to the step's precision, but drop trailing zeros (1.00 → 1, 1.50 → 1.5).
  const display = useCallback((n) => `${Number(Number(n).toFixed(decimals))}${suffix}`, [decimals, suffix]);

  const [text, setText] = useState(() => display(value));
  const focusedRef = useRef(false);
  const draggingRef = useRef(false);
  const inputRef = useRef(null);

  // Re-sync the input text when the stored value changes from outside, unless the
  // user is actively typing in this field.
  useEffect(() => {
    if (!focusedRef.current && !draggingRef.current) setText(display(value));
  }, [value, display]);

  /**
   * One drag implementation, entered three ways:
   *  - from the icon tab: scrubbing starts on pointerdown (`arm: false`);
   *  - from the property label: same, so a tablet can drag the name (the wide
   *    always-visible strip) without focusing the value;
   *  - from the value itself: scrubbing only starts once the pointer has actually
   *    moved (`arm: true`), so a plain click still places the caret and types.
   * The value entry exists because the field skin hides the icon tab until
   * hover — on a pointer that can hover, the value still has to carry drag.
   */
  const startDrag = useCallback((e, arm) => {
    if (arm && focusedRef.current) return; // typing: let the mouse select text
    const startVal = parseLeadingNumber(text) ?? (Number.isFinite(value) ? value : 0);
    beginVerticalScrub(e, {
      arm,
      disabled,
      startVal,
      step,
      clampFn: clamp,
      onInput: (next) => {
        setText(display(next));
        onInput?.(next);
      },
      onCommit,
      onEngage: () => {
        draggingRef.current = true;
        inputRef.current?.blur();
      },
      onRelease: () => { draggingRef.current = false; },
    });
  }, [text, value, clamp, step, display, onInput, onCommit, disabled]);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const base = parseLeadingNumber(text) ?? (Number.isFinite(value) ? value : 0);
      const dir = e.key === 'ArrowUp' ? 1 : -1;
      const mult = stepMultiplier(e);
      const next = clamp(base + dir * step * mult);
      setText(display(next));
      onInput?.(next);
      onCommit?.();
    } else if (e.key === 'Enter') {
      e.currentTarget.blur();
    }
  }, [text, value, clamp, step, display, onInput, onCommit]);

  const handleChange = useCallback((e) => {
    setText(e.target.value);
    const n = parseLeadingNumber(e.target.value);
    if (n != null) onInput?.(clamp(n));
  }, [clamp, onInput]);

  const handleBlur = useCallback(() => {
    focusedRef.current = false;
    const n = parseLeadingNumber(text);
    if (n != null) {
      const c = clamp(n);
      setText(display(c));
      onInput?.(c);
      onCommit?.();
    } else {
      setText(display(value));
    }
  }, [text, value, clamp, display, onInput, onCommit]);

  // The default is put through the same clamp the typed value gets, so a
  // descriptor whose default sits outside its own min/max still produces a dot
  // that can actually be dismissed. Comparing at the field's precision keeps a
  // difference the user can't see from lighting a dot they can't explain.
  const defNum = Number.isFinite(defaultValue) ? clamp(defaultValue) : null;
  const offDefault = defNum != null && Number.isFinite(value)
    && Number(Number(value).toFixed(decimals)) !== defNum;
  const resetToDefault = useCallback(() => {
    setText(display(defNum));
    onInput?.(defNum);
    onCommit?.();
  }, [defNum, display, onInput, onCommit]);

  // A keyframed field is read-only — the track owns the value, so a reset that
  // wrote the static number would be a lie.
  const resetDot = (
    <FieldResetDot
      changed={offDefault && !disabled}
      onReset={resetToDefault}
      title={`Reset to default (${display(defNum)})`}
    />
  );

  return (
    <div className={`ve-field${disabled ? ' ve-field-disabled' : ''}`} title={disabled ? disabledReason : title}>
      {label && (
        <FieldLabel
          action={<>{resetDot}{labelAction}</>}
          onScrubPointerDown={disabled ? undefined : (e) => { e.stopPropagation(); startDrag(e, false); }}
          scrubTitle="Drag to adjust — Shift ×10, Alt ×0.1"
        >
          {label}
        </FieldLabel>
      )}
      <div className="ve-field-control ve-field-number">
        {/* ve-field-icon-auto = the default drag handle, which the skin folds away
            until hover. A caller-supplied icon (the X/Y/Z axis chips) is the
            field's only label, so it always stays visible. */}
        <span
          className={`ve-field-icon ve-field-icon-drag${icon ? '' : ' ve-field-icon-auto'}`}
          onPointerDown={(e) => startDrag(e, false)}
          title="Drag to adjust — Shift ×10, Alt ×0.1"
        >
          {icon || <DragHandleIcon />}
        </span>
        <input
          ref={inputRef}
          type="text"
          inputMode="decimal"
          className="ve-field-input"
          value={text}
          placeholder={placeholder}
          disabled={disabled}
          onPointerDown={(e) => startDrag(e, true)}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onFocus={() => { focusedRef.current = true; }}
          onBlur={handleBlur}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
        />
      </div>
    </div>
  );
}

/** Styled dropdown matching the field look. Pass <option>s as children. */
export function SelectField({ label, labelAction, value, onChange, children, title, disabled, disabledReason }) {
  return (
    <div className={`ve-field${disabled ? ' ve-field-disabled' : ''}`} title={disabled && disabledReason ? disabledReason : title}>
      {label && <FieldLabel action={labelAction}>{label}</FieldLabel>}
      <div className="ve-field-control ve-field-select">
        <select
          className="ve-field-select-el"
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        >
          {children}
        </select>
        <ChevronDownIcon />
      </div>
    </div>
  );
}

/* ── Portal dropdown ───────────────────────────────────────────
   The inspector body is `overflow-y: auto`, which per spec also clips overflow-x,
   so an absolutely-positioned dropdown inside it gets cropped near the panel
   edges. Rendering the menu through a <body> portal with position:fixed lets it
   escape that clip. Position is derived from the anchor's rect (and re-derived on
   scroll/resize), flipping above the anchor when there isn't room below. Mirrors
   the useHoverTip body-portal pattern. Lives here (not EffectPicker) because the
   field primitives need it too and EffectPicker imports THIS file. */
export function PortalPopover({ open, anchorRef, align = 'left', className, onClose, children, maxHeight = 300 }) {
  const panelRef = useRef(null);
  const [pos, setPos] = useState(null);

  useLayoutEffect(() => {
    if (!open) { setPos(null); return undefined; }
    const compute = () => {
      const el = anchorRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const gap = 6;
      const spaceBelow = window.innerHeight - r.bottom - gap - 8;
      const spaceAbove = r.top - gap - 8;
      const openUp = spaceBelow < 220 && spaceAbove > spaceBelow;
      setPos({
        openUp,
        top: r.bottom + gap,
        bottom: window.innerHeight - r.top + gap,
        left: align === 'left' ? r.left : align === 'center' ? r.left + r.width / 2 : null,
        right: align === 'right' ? window.innerWidth - r.right : null,
        center: align === 'center',
        maxHeight: Math.max(160, Math.min(maxHeight, openUp ? spaceAbove : spaceBelow)),
      });
    };
    compute();
    window.addEventListener('resize', compute);
    window.addEventListener('scroll', compute, true);
    return () => {
      window.removeEventListener('resize', compute);
      window.removeEventListener('scroll', compute, true);
    };
  }, [open, align, anchorRef, maxHeight]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (anchorRef.current?.contains(e.target)) return;
      if (panelRef.current?.contains(e.target)) return;
      onClose?.();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, onClose, anchorRef]);

  if (!open || !pos) return null;
  const style = {
    position: 'fixed',
    left: pos.left != null ? pos.left : 'auto',
    right: pos.right != null ? pos.right : 'auto',
    top: pos.openUp ? 'auto' : pos.top,
    bottom: pos.openUp ? pos.bottom : 'auto',
    maxHeight: pos.maxHeight,
    zIndex: 10000,
  };
  if (pos.center) style.transform = 'translateX(-50%)';
  return createPortal(
    <div ref={panelRef} className={className} style={style}>
      {children}
    </div>,
    document.body,
  );
}

/* Search-hit emphasis for PopoverSelect rows: the matched run in <b>. */
function MatchText({ text, query }) {
  const t = String(text ?? '');
  if (!query) return t;
  const i = t.toLowerCase().indexOf(query);
  if (i < 0) return t;
  return (
    <>
      {t.slice(0, i)}<b>{t.slice(i, i + query.length)}</b>{t.slice(i + query.length)}
    </>
  );
}

function CheckIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="4 12.5 9.5 18 20 6.5" />
    </svg>
  );
}

/**
 * PopoverSelect — a dropdown whose list is OURS, not the OS's.
 *
 * The native <select> popup on macOS is a system menu: arrowing through it moves
 * a highlight and fires `change` only on Enter or click, so a Blend Mode could
 * not be previewed by arrowing. Here ↑/↓ SET the value as they move — the list
 * stays open and the canvas follows — Enter or a click keeps the value and
 * closes, Escape puts back the value the list opened with and closes. The closed
 * trigger arrows too, like a native select. `searchable` adds a live filter box
 * (the layer-reference lists), and ↑/↓ then walk the filtered rows.
 *
 * options: [{ value, label, group?, sub?, flag?, warn?, disabled? }]
 *   group — a header is emitted where the group changes (keep options grouped)
 *   sub   — muted second line (a layer's channel)
 *   flag  — muted trailer on the label line ("hidden")
 *   warn  — the row describes a problem (a missing layer)
 * Values round-trip as STRINGS, like a <select>, so callers keep their
 * `onChange(v)` signature unchanged from SelectField.
 */
export function PopoverSelect({
  label, labelAction, value, onChange, options = [], title, disabled, disabledReason,
  placeholder = '—', searchable = false, searchPlaceholder = 'Search…', emptyText = 'No match',
  width = 236,
}) {
  const anchorRef = useRef(null);
  const listRef = useRef(null);
  const openedWith = useRef('');
  const scrolledOnOpen = useRef(false);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const strVal = value == null ? '' : String(value);
  const currentOpt = options.find((o) => String(o.value) === strVal) || null;
  const q = query.trim().toLowerCase();
  const matches = (o) => !q
    || String(o.label ?? '').toLowerCase().includes(q)
    || String(o.sub ?? '').toLowerCase().includes(q)
    || String(o.group ?? '').toLowerCase().includes(q)
    || String(o.flag ?? '').toLowerCase().includes(q);
  const visible = options.filter(matches);

  const commit = useCallback((v) => {
    const next = String(v);
    if (next !== strVal) onChange(next);
  }, [onChange, strVal]);

  const close = useCallback((refocus) => {
    setOpen(false);
    setQuery('');
    if (refocus) anchorRef.current?.focus();
  }, []);

  const openMenu = () => {
    if (disabled) return;
    openedWith.current = strVal;
    scrolledOnOpen.current = false;
    setQuery('');
    setOpen(true);
  };

  // Move the VALUE by `dir` rows through the walkable list (visible, enabled).
  // A value outside that list — filtered away, or None while only real rows
  // remain — starts from the nearest end.
  const step = (dir, list = visible) => {
    const walk = list.filter((o) => !o.disabled);
    if (!walk.length) return;
    const cur = walk.findIndex((o) => String(o.value) === strVal);
    let next;
    if (dir === Infinity) next = walk.length - 1;
    else if (dir === -Infinity) next = 0;
    else if (cur < 0) next = dir > 0 ? 0 : walk.length - 1;
    else next = Math.min(walk.length - 1, Math.max(0, cur + dir));
    commit(walk[next].value);
  };

  const onPanelKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); step(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); step(-1); }
    else if (e.key === 'Home' && !(searchable && query)) { e.preventDefault(); step(-Infinity); }
    else if (e.key === 'End' && !(searchable && query)) { e.preventDefault(); step(Infinity); }
    else if (e.key === 'Enter') { e.preventDefault(); close(true); }
    else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (openedWith.current !== strVal) onChange(openedWith.current);
      close(true);
    } else if (e.key === 'Tab') { close(false); }
  };

  // The closed trigger behaves like a focused native <select>: arrows step
  // the value in place, Enter/Space (the button's own click) open the list.
  const onTriggerKey = (e) => {
    if (open || disabled) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); step(1, options); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); step(-1, options); }
  };

  // Keyboard focus lands IN the popover: on the filter box when there is one,
  // else on the panel itself, so ↑/↓ work without a click. Callback refs
  // because the portal mounts a render after `open` flips.
  const panelRefCb = (el) => {
    if (el && !searchable && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
  };
  const listRefCb = (el) => {
    listRef.current = el;
    if (el && !scrolledOnOpen.current) {
      scrolledOnOpen.current = true;
      el.querySelector('.is-current')?.scrollIntoView({ block: 'center' });
    }
  };
  // Keep the (moving) current row in view while arrowing.
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector('.is-current')?.scrollIntoView({ block: 'nearest' });
  }, [open, strVal]);

  const triggerText = currentOpt ? currentOpt.label : (strVal ? `(${strVal})` : placeholder);

  let lastGroup = null;
  const rows = [];
  visible.forEach((o) => {
    if (o.group && o.group !== lastGroup) {
      rows.push(<div key={`g-${o.group}`} className="ve-popsel-ghead">{o.group}</div>);
    }
    lastGroup = o.group || null;
    const isCur = String(o.value) === strVal;
    rows.push(
      <button
        key={`o-${String(o.value)}`}
        type="button"
        role="option"
        aria-selected={isCur}
        disabled={!!o.disabled}
        className={`ve-popsel-row${isCur ? ' is-current' : ''}${o.warn ? ' is-warn' : ''}${o.sub ? ' has-sub' : ''}`}
        onClick={() => { commit(o.value); close(true); }}
      >
        <span className="ve-popsel-check">{isCur && <CheckIcon />}</span>
        <span className="ve-popsel-text">
          <span className="ve-popsel-name"><MatchText text={o.label} query={q} /></span>
          {o.sub && <span className="ve-popsel-sub"><MatchText text={o.sub} query={q} /></span>}
        </span>
        {o.flag && <span className="ve-popsel-flag">{o.flag}</span>}
      </button>,
    );
  });

  return (
    <div className={`ve-field${disabled ? ' ve-field-disabled' : ''}`} title={disabled && disabledReason ? disabledReason : title}>
      {label && <FieldLabel action={labelAction}>{label}</FieldLabel>}
      <div className={`ve-field-control ve-field-select ve-popsel-ctl${open ? ' open' : ''}${currentOpt?.warn ? ' is-warn' : ''}`}>
        <button
          ref={anchorRef}
          type="button"
          className="ve-field-select-el ve-popsel-btn"
          disabled={disabled}
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => (open ? close(false) : openMenu())}
          onKeyDown={onTriggerKey}
        >
          <span className="ve-popsel-btn-text">{triggerText}</span>
        </button>
        <ChevronDownIcon />
      </div>
      <PortalPopover open={open} anchorRef={anchorRef} align="right" className="ve-popsel-pop" onClose={() => close(false)} maxHeight={searchable ? 420 : 480}>
        <div ref={panelRefCb} className="ve-popsel" tabIndex={-1} onKeyDown={onPanelKey} style={{ width }}>
          {searchable && (
            <div className="ve-popsel-search">
              <span className="ve-popsel-search-icon">⌕</span>
              <input
                type="text"
                autoFocus
                value={query}
                placeholder={searchPlaceholder}
                onChange={(e) => setQuery(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
              {query
                ? <button type="button" className="ve-popsel-clear" aria-label="Clear search" onClick={() => setQuery('')}>×</button>
                : <kbd>esc</kbd>}
            </div>
          )}
          <div className="ve-popsel-scroll" ref={listRefCb} role="listbox">
            {visible.length === 0 && <div className="ve-popsel-none">{emptyText}{q ? <> for “<b>{query.trim()}</b>”</> : null}</div>}
            {rows}
          </div>
          <div className="ve-popsel-foot">
            {searchable ? <span><b>{visible.length}</b> of {options.length}</span> : <span />}
            <span>↑↓ pick live · ↵ keep · esc revert</span>
          </div>
        </div>
      </PortalPopover>
    </div>
  );
}

/**
 * Segmented pill control (the Align / Decoration / Letter-Case style).
 * options: [{ value, label: ReactNode, title? }]
 *
 * `stacked`: the label takes its own line and the chips share the full width.
 * An explicit opt-in for the few controls whose chip text would otherwise wrap
 * to two lines in the 264px column (measured, not guessed — see the particle
 * panel). It is NOT inferred from the labels: an inference by text length read
 * icon labels as "[object Object]" and stacked every icon control in the app.
 */
export function SegmentedControl({ label, labelAction, value, onChange, options, stacked = false }) {
  return (
    <div className={`ve-field${stacked && label ? ' ve-field-stacked' : ''}`}>
      {label && <FieldLabel action={labelAction}>{label}</FieldLabel>}
      <div className="ve-field-segmented" role="group">
        {options.map((opt) => (
          <button
            key={opt.value}
            type="button"
            title={opt.title}
            className={`ve-field-seg-btn${value === opt.value ? ' active' : ''}`}
            onClick={() => onChange(opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Single-line text field. */
export function TextField({ label, labelAction, value, onChange, placeholder, title, autoFocus, onKeyDown }) {
  return (
    <div className="ve-field" title={title}>
      {label && <FieldLabel action={labelAction}>{label}</FieldLabel>}
      <div className="ve-field-control">
        <input
          type="text"
          className="ve-field-input"
          value={value}
          placeholder={placeholder}
          autoFocus={autoFocus}
          onKeyDown={onKeyDown}
          onChange={(e) => onChange(e.target.value)}
          autoComplete="off"
        />
      </div>
    </div>
  );
}

/** Multi-line text area. */
export function TextArea({ label, labelAction, value, onChange, placeholder, title, rows, inputRef }) {
  return (
    <div className="ve-field" title={title}>
      {label && <FieldLabel action={labelAction}>{label}</FieldLabel>}
      <div className="ve-field-control">
        <textarea
          ref={inputRef}
          className="ve-field-input ve-field-textarea"
          value={value}
          placeholder={placeholder}
          rows={rows}
          onChange={(e) => onChange(e.target.value)}
          autoComplete="off"
        />
      </div>
    </div>
  );
}

/**
 * Label + track + typed readout on one row.
 *
 * For properties where the *relative* position matters as much as the number —
 * Opacity, Scale — the track answers "how far along am I" at a glance, which a
 * bare number can't. The readout is a real NumberField, so drag-to-scrub,
 * arrow-key nudging and typing all still work; the track is just a second way in.
 */
export function SliderField({
  label,
  labelAction,
  value,
  defaultValue,
  onInput,
  onCommit,
  min = 0,
  max = 100,
  step = 1,
  suffix = '',
  precision,
  title,
  disabled = false,
  disabledReason = 'Controlled by keyframes',
  // Optional CSS background for the track (e.g. a blue→amber temperature ramp);
  // a painted track carries no fill — the ramp already says where you are.
  track,
  // Fill from the middle instead of from min, for signed controls around 0.
  bipolar = false,
}) {
  const trackRef = useRef(null);
  const span = max - min;
  const clamped = Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
  const pct = span > 0 ? (clamped - min) / span : 0;
  // The readout is an unlabelled NumberField, so the reset dot can't ride along
  // with it — this row owns the label, so it owns the dot too.
  const decimals = precision != null ? precision : decimalsForStep(step);
  const defNum = Number.isFinite(defaultValue)
    ? Number(Math.min(max, Math.max(min, defaultValue)).toFixed(decimals))
    : null;
  const offDefault = defNum != null && Number.isFinite(value)
    && Number(Number(value).toFixed(decimals)) !== defNum;

  const setFromX = useCallback((clientX) => {
    const el = trackRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const t = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    const raw = min + t * span;
    // Snap to the step so the track can't produce a value the field can't show.
    const snapped = Math.round(raw / step) * step;
    const decimals = precision != null ? precision : decimalsForStep(step);
    onInput?.(Number(Math.min(max, Math.max(min, snapped)).toFixed(decimals)));
  }, [min, max, span, step, precision, onInput]);

  const handleDown = useCallback((e) => {
    if (disabled) return;
    e.preventDefault();
    setFromX(e.clientX);
    const move = (me) => setFromX(me.clientX);
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
      onCommit?.();
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
  }, [disabled, setFromX, onCommit]);

  const startLabelDrag = useCallback((e) => {
    e.stopPropagation();
    beginVerticalScrub(e, {
      arm: false,
      disabled,
      startVal: Number.isFinite(value) ? value : min,
      step,
      clampFn: (n) => Number(Math.min(max, Math.max(min, n)).toFixed(decimals)),
      onInput,
      onCommit,
    });
  }, [disabled, value, min, max, step, decimals, onInput, onCommit]);

  return (
    <div className={`ve-field ve-field-slider-field${disabled ? ' ve-field-disabled' : ''}`} title={disabled ? disabledReason : title}>
      {label && (
        <FieldLabel
          action={(
            <>
              <FieldResetDot
                changed={offDefault && !disabled}
                onReset={() => { onInput?.(defNum); onCommit?.(); }}
                title={`Reset to default (${defNum}${suffix})`}
              />
              {labelAction}
            </>
          )}
          onScrubPointerDown={disabled ? undefined : startLabelDrag}
          scrubTitle="Drag to adjust — Shift ×10, Alt ×0.1"
        >
          {label}
        </FieldLabel>
      )}
      <div className="ve-field-slider-row">
        <div
          className={`ve-field-slider${track ? ' ve-field-slider-painted' : ''}${bipolar && !track ? ' ve-field-slider-bipolar' : ''}`}
          ref={trackRef}
          style={track ? { '--ve-slider-p': pct, '--ve-slider-track': track } : { '--ve-slider-p': pct }}
          onPointerDown={handleDown}
          role="slider"
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={clamped}
          tabIndex={-1}
        >
          <span className="ve-field-slider-fill" />
          <span className="ve-field-slider-thumb" />
        </div>
        <div className="ve-field-slider-num">
          <NumberField
            value={value}
            min={min}
            max={max}
            step={step}
            suffix={suffix}
            precision={precision}
            disabled={disabled}
            disabledReason={disabledReason}
            onInput={onInput}
            onCommit={onCommit}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * Transform-origin picker: a 3×3 of points showing which corner/edge/centre is
 * anchored, opening a bigger grid to pick from. A select forced you to read
 * "Bottom Right" and picture it; the grid IS the picture, and it costs a third
 * of the width of the select it replaces.
 *
 * `value` / `onChange` speak row-major index 0..8 (TL, T, TR, L, C, R, BL, B, BR);
 * callers map that to whatever they store.
 */
const ORIGIN_CELL_LABELS = [
  'Top left', 'Top', 'Top right',
  'Left', 'Center', 'Right',
  'Bottom left', 'Bottom', 'Bottom right',
];

export function OriginField({ label, labelAction, value = 4, onChange, title, disabled = false }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef(null);
  const popRef = useRef(null);
  const [pos, setPos] = useState(null);
  const index = Number.isFinite(value) && value >= 0 && value <= 8 ? value : 4;

  useLayoutEffect(() => {
    if (!open) { setPos(null); return undefined; }
    const compute = () => {
      const el = btnRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const w = 150;
      const openUp = window.innerHeight - r.bottom < 190;
      setPos({
        top: openUp ? null : r.bottom + 6,
        bottom: openUp ? window.innerHeight - r.top + 6 : null,
        left: Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w)),
      });
    };
    compute();
    window.addEventListener('resize', compute);
    window.addEventListener('scroll', compute, true);
    return () => {
      window.removeEventListener('resize', compute);
      window.removeEventListener('scroll', compute, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (btnRef.current?.contains(e.target) || popRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const cells = Array.from({ length: 9 }, (_, i) => i);

  return (
    <div className={`ve-field${disabled ? ' ve-field-disabled' : ''}`} title={title} style={{justifyContent: "start", alignItems: "center", flexDirection:"row"}}>
      {label && <FieldLabel action={labelAction}>{label}</FieldLabel>}
      <div className="ve-field-origin-wrap">
        <button
          type="button"
          ref={btnRef}
          className={`ve-origin-trigger${open ? ' open' : ''}`}
          disabled={disabled}
          title={`Transform origin — ${ORIGIN_CELL_LABELS[index]}`}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="ve-origin-mini">
            {cells.map((i) => (
              <span key={i} className={`ve-origin-mini-dot${i === index ? ' on' : ''}`} />
            ))}
          </span>
        </button>
        {open && pos && createPortal(
          <div
            ref={popRef}
            className="ve-origin-pop"
            style={{ top: pos.top ?? undefined, bottom: pos.bottom ?? undefined, left: pos.left }}
          >
            <div className="ve-origin-grid">
              {cells.map((i) => (
                <button
                  key={i}
                  type="button"
                  className={`ve-origin-cell${i === index ? ' on' : ''}`}
                  title={ORIGIN_CELL_LABELS[i]}
                  onClick={() => { onChange?.(i); setOpen(false); }}
                >
                  <span className="ve-origin-cell-dot" />
                </button>
              ))}
            </div>
            <div className="ve-origin-pop-name">{ORIGIN_CELL_LABELS[index]}</div>
          </div>,
          document.body,
        )}
      </div>
    </div>
  );
}

/* Percent-of-composition coordinates for the nine origin cells, in the same
   row-major order OriginField speaks. 8/92 rather than 0/100: a point on the
   very edge has nothing on one side of it, which is never what "top left"
   means when you are aiming a zoom or a move. */
const POINT_PRESET_COORDS = [
  [8, 8], [50, 8], [92, 8],
  [8, 50], [50, 50], [92, 50],
  [8, 92], [50, 92], [92, 92],
];

const POINT_AXES = [
  { key: 'x', label: 'X' },
  { key: 'y', label: 'Y' },
  { key: 'z', label: 'Z' },
];

/**
 * Point control — the inline row: a target chip that arms the preview picker, a
 * 3×3 preset chip (the same one Transform Origin uses) and one hairline number
 * per axis. It is a normal field row, so it drops into a property list without
 * costing any extra height.
 *
 * `value` is `{ x, y, z }` in PERCENT OF COMPOSITION (x/z over width, y over
 * height) so a saved point survives a resolution change. `axes` is 2 or 3; the
 * Z field simply isn't rendered for 2.
 */
export function PointField({
  label,
  labelAction,
  value,
  axes = 2,
  onInput,
  onCommit,
  min = -100,
  max = 200,
  step = 0.5,
  title,
  disabled = false,
  pickLabel,
}) {
  const [picking, setPicking] = useState(false);
  const [presetOpen, setPresetOpen] = useState(false);
  const presetBtnRef = useRef(null);
  const presetPopRef = useRef(null);
  const [presetPos, setPresetPos] = useState(null);
  const pickIdRef = useRef(null);
  // The pick lands one gesture later, by which time this closure's props are
  // stale — so the handler reads the point and callbacks from a live ref.
  const latest = useRef(null);

  // A 2-axis field never writes a z: storing one would put a value in the
  // project that nothing reads and that the option resolver would then have to
  // decide what to do with.
  const point = axes >= 3
    ? {
      x: Number.isFinite(value?.x) ? value.x : 50,
      y: Number.isFinite(value?.y) ? value.y : 50,
      z: Number.isFinite(value?.z) ? value.z : 0,
    }
    : {
      x: Number.isFinite(value?.x) ? value.x : 50,
      y: Number.isFinite(value?.y) ? value.y : 50,
    };
  latest.current = { point, onInput, onCommit };
  const shown = axes >= 3 ? POINT_AXES : POINT_AXES.slice(0, 2);

  const emit = (patch) => {
    const live = latest.current;
    live.onInput?.({ ...live.point, ...patch });
  };

  // Arming is a subscription, not fire-and-forget: another control (or the
  // stage's Escape handler) can disarm us, and the chip has to follow.
  useEffect(() => subscribePointPick((request) => {
    const mine = !!request && request.id === pickIdRef.current;
    if (!mine) pickIdRef.current = null;
    setPicking(mine);
  }), []);

  const togglePick = () => {
    if (disabled) return;
    if (pickIdRef.current != null) {
      cancelPointPick(pickIdRef.current);
      return;
    }
    pickIdRef.current = requestPointPick({
      label: pickLabel || label || 'point',
      onPick: ({ x, y }) => {
        pickIdRef.current = null;
        const live = latest.current;
        live.onInput?.({ ...live.point, x: round1(x), y: round1(y) });
        live.onCommit?.();
      },
      onCancel: () => { pickIdRef.current = null; },
    });
    setPicking(true);
  };

  useLayoutEffect(() => {
    if (!presetOpen) { setPresetPos(null); return undefined; }
    const compute = () => {
      const el = presetBtnRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const w = 150;
      const openUp = window.innerHeight - r.bottom < 190;
      setPresetPos({
        top: openUp ? null : r.bottom + 6,
        bottom: openUp ? window.innerHeight - r.top + 6 : null,
        left: Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w)),
      });
    };
    compute();
    window.addEventListener('resize', compute);
    window.addEventListener('scroll', compute, true);
    return () => {
      window.removeEventListener('resize', compute);
      window.removeEventListener('scroll', compute, true);
    };
  }, [presetOpen]);

  useEffect(() => {
    if (!presetOpen) return undefined;
    const onDown = (e) => {
      if (presetBtnRef.current?.contains(e.target) || presetPopRef.current?.contains(e.target)) return;
      setPresetOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setPresetOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [presetOpen]);

  const presetIndex = POINT_PRESET_COORDS.findIndex(([px, py]) => px === point.x && py === point.y);
  const cells = Array.from({ length: 9 }, (_, i) => i);

  return (
    <div className={`ve-field ve-point-field${disabled ? ' ve-field-disabled' : ''}`} title={title}>
      {label && <FieldLabel action={labelAction}>{label}</FieldLabel>}
      <div className="ve-point-controls">
        <button
          type="button"
          className={`ve-point-pick${picking ? ' on' : ''}`}
          disabled={disabled}
          title={picking ? 'Click in the preview to place the point — Esc cancels' : 'Pick a point in the preview'}
          aria-pressed={picking}
          onClick={togglePick}
        >
          <TargetIcon />
        </button>

        <div className="ve-point-preset-wrap">
          <button
            type="button"
            ref={presetBtnRef}
            className={`ve-origin-trigger${presetOpen ? ' open' : ''}`}
            disabled={disabled}
            title={presetIndex >= 0 ? `Preset — ${ORIGIN_CELL_LABELS[presetIndex]}` : 'Point presets'}
            onClick={() => setPresetOpen((v) => !v)}
          >
            <span className="ve-origin-mini">
              {cells.map((i) => (
                <span key={i} className={`ve-origin-mini-dot${i === presetIndex ? ' on' : ''}`} />
              ))}
            </span>
          </button>
          {presetOpen && presetPos && createPortal(
            <div
              ref={presetPopRef}
              className="ve-origin-pop"
              style={{ top: presetPos.top ?? undefined, bottom: presetPos.bottom ?? undefined, left: presetPos.left }}
            >
              <div className="ve-origin-grid">
                {cells.map((i) => (
                  <button
                    key={i}
                    type="button"
                    className={`ve-origin-cell${i === presetIndex ? ' on' : ''}`}
                    title={ORIGIN_CELL_LABELS[i]}
                    onClick={() => {
                      const [px, py] = POINT_PRESET_COORDS[i];
                      onInput?.({ ...point, x: px, y: py });
                      onCommit?.();
                      setPresetOpen(false);
                    }}
                  >
                    <span className="ve-origin-cell-dot" />
                  </button>
                ))}
              </div>
              <div className="ve-origin-pop-name">
                {presetIndex >= 0 ? ORIGIN_CELL_LABELS[presetIndex] : 'Custom'}
              </div>
            </div>,
            document.body,
          )}
        </div>

        {shown.map((axis) => (
          <div className={`ve-point-axis ve-point-axis-${axis.key}`} key={axis.key}>
            <NumberField
              icon={axis.label}
              value={point[axis.key]}
              min={min}
              max={max}
              step={step}
              suffix="%"
              disabled={disabled}
              title={`${label || 'Point'} ${axis.label}`}
              onInput={(v) => emit({ [axis.key]: v })}
              onCommit={onCommit}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function TargetIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <circle cx="12" cy="12" r="4.2" />
      <path d="M12 1.6v4M12 18.4v4M1.6 12h4M18.4 12h4" strokeLinecap="round" />
    </svg>
  );
}

const round1 = (v) => Math.round(v * 10) / 10;

/*
 * Ready-made motion paths (percent of comp), mirroring the look-dev lab's
 * presets. Loading one replaces the anchors and resets every share to even.
 */
const PATH_FIELD_PRESETS = [
  { id: 'rbd', label: 'Smooth → ↓', pts: [[14, 26], [68, 26], [68, 78]] },
  { id: 'rtu', label: 'Smooth → ↑', pts: [[14, 74], [68, 74], [68, 22]] },
  { id: 'dl', label: 'Smooth ↓ ←', pts: [[76, 18], [76, 66], [22, 66]] },
  { id: 's', label: 'S-curve →', pts: [[12, 32], [46, 32], [54, 68], [88, 68]] },
  { id: 'arc', label: 'Arc over', pts: [[16, 68], [50, 22], [84, 68]] },
  { id: 'u', label: 'U-turn → ←', pts: [[16, 32], [72, 36], [72, 64], [16, 68]] },
];

/**
 * Motion-path control (Advanced Movement's `travelPath` option).
 *
 * `value` is `{ points, shares }` — anchors in PERCENT OF COMPOSITION (the
 * shared point convention, so a path survives a resolution change) and one
 * timing share per segment (weights; how long the move spends reaching each
 * next anchor).
 *
 * Drawing works like the shape tools: the ✚ chip arms the shared preview
 * picker and RE-ARMS itself after every pick, so clicking around the preview
 * lays the path down anchor by anchor — Esc (or clicking the chip again)
 * stops. Each anchor row edits or removes one anchor; removing an interior
 * anchor merges its two segments' time.
 */
export function PathField({ label, value, onInput, onCommit, disabled = false }) {
  const [drawing, setDrawing] = useState(false);
  const pickIdRef = useRef(null);
  // Picks land a gesture later, when this closure's props are stale — the
  // handler reads everything live from a ref, same as PointField.
  const latest = useRef(null);

  const points = (Array.isArray(value?.points) ? value.points : [])
    .filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y));
  const segments = Math.max(0, points.length - 1);
  const shares = Array.from({ length: segments }, (_, i) => {
    const w = value?.shares?.[i];
    return Number.isFinite(w) ? w : 100;
  });

  const write = (nextPoints, nextShares, { commit = true } = {}) => {
    const live = latest.current;
    const pts = nextPoints.map((p) => ({ x: round1(p.x), y: round1(p.y) }));
    const segs = Math.max(0, pts.length - 1);
    const shr = nextShares.slice(0, segs).map((w) => (Number.isFinite(w) ? w : 100));
    while (shr.length < segs) shr.push(100);
    live.onInput?.({ points: pts, shares: shr });
    if (commit) live.onCommit?.();
  };
  latest.current = { points, shares, onInput, onCommit, write };

  useEffect(() => subscribePointPick((request) => {
    const mine = !!request && request.id === pickIdRef.current;
    if (!mine && pickIdRef.current != null && request) pickIdRef.current = null;
    setDrawing((was) => (was === mine ? was : mine));
  }), []);
  // A control that unmounts while armed would leave the preview waiting on a
  // pick nothing will read.
  useEffect(() => () => {
    if (pickIdRef.current != null) cancelPointPick(pickIdRef.current);
  }, []);

  const armDraw = () => {
    if (disabled) return;
    if (pickIdRef.current != null) {
      cancelPointPick(pickIdRef.current);
      return;
    }
    const arm = () => {
      pickIdRef.current = requestPointPick({
        label: 'path anchor',
        onPick: ({ x, y }) => {
          pickIdRef.current = null;
          const live = latest.current;
          live.write([...live.points, { x, y }], live.shares);
          arm();                       // sequential drawing: keep the picker hot
        },
        onCancel: () => { pickIdRef.current = null; },
      });
      setDrawing(true);
    };
    arm();
  };

  const removePoint = (index) => {
    const nextShares = shares.slice();
    if (index === 0) nextShares.shift();
    else if (index === points.length - 1) nextShares.pop();
    else {
      // Interior anchor: its two segments become one, keeping their total time.
      nextShares[index - 1] = Math.min(500, nextShares[index - 1] + nextShares[index]);
      nextShares.splice(index, 1);
    }
    write(points.filter((_, i) => i !== index), nextShares);
  };

  const presetId = PATH_FIELD_PRESETS.find((preset) => (
    preset.pts.length === points.length
    && preset.pts.every(([px, py], i) => px === points[i].x && py === points[i].y)
  ))?.id || 'custom';

  return (
    <div className={`ve-path-field${disabled ? ' ve-field-disabled' : ''}`}>
      <div className="ve-field ve-path-head">
        {label && <FieldLabel>{label}</FieldLabel>}
        <div className="ve-path-head-controls">
          <select
            className="ve-path-preset"
            value={presetId}
            disabled={disabled}
            title="Path presets"
            onChange={(e) => {
              const preset = PATH_FIELD_PRESETS.find((entry) => entry.id === e.target.value);
              if (preset) write(preset.pts.map(([x, y]) => ({ x, y })), []);
            }}
          >
            <option value="custom">{points.length ? 'Custom' : 'Pick a preset…'}</option>
            {PATH_FIELD_PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id}>{preset.label}</option>
            ))}
          </select>
          <button
            type="button"
            className={`ve-point-pick${drawing ? ' on' : ''}`}
            disabled={disabled}
            title={drawing
              ? 'Click the preview to add anchors — Esc (or click again) stops'
              : 'Draw anchors in the preview, click by click'}
            aria-pressed={drawing}
            onClick={armDraw}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <path d="M12 5v14M5 12h14" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </div>
      {points.map((p, i) => (
        <div className="ve-path-row" key={i}>
          <span className={`ve-path-idx${i === 0 ? ' first' : ''}`} title={i === 0 ? 'Path start — the clip travels relative to this' : undefined}>{i + 1}</span>
          <div className="ve-point-axis ve-point-axis-x">
            <NumberField
              icon="X"
              value={p.x}
              min={-100}
              max={200}
              step={0.5}
              suffix="%"
              disabled={disabled}
              onInput={(v) => write(points.map((pt, j) => (j === i ? { ...pt, x: v } : pt)), shares, { commit: false })}
              onCommit={onCommit}
            />
          </div>
          <div className="ve-point-axis ve-point-axis-y">
            <NumberField
              icon="Y"
              value={p.y}
              min={-100}
              max={200}
              step={0.5}
              suffix="%"
              disabled={disabled}
              onInput={(v) => write(points.map((pt, j) => (j === i ? { ...pt, y: v } : pt)), shares, { commit: false })}
              onCommit={onCommit}
            />
          </div>
          <button
            type="button"
            className="ve-path-del"
            disabled={disabled}
            title="Remove this anchor"
            onClick={() => removePoint(i)}
          >
            ×
          </button>
        </div>
      ))}
      {segments >= 1 && (
        <div className="ve-path-shares">
          <span className="ve-path-shares-label" title="How long the move spends reaching each next anchor — weights, normalized">Timing</span>
          {shares.map((w, i) => (
            <div className="ve-point-axis ve-path-share" key={i}>
              <NumberField
                icon={String(i + 1)}
                value={w}
                min={5}
                max={500}
                step={5}
                disabled={disabled}
                onInput={(v) => write(points, shares.map((sw, j) => (j === i ? v : sw)), { commit: false })}
                onCommit={onCommit}
              />
            </div>
          ))}
          <button
            type="button"
            className="ve-path-even"
            disabled={disabled}
            title="Reset every segment to an even share"
            onClick={() => write(points, shares.map(() => 100))}
          >
            Even
          </button>
        </div>
      )}
      {!points.length && (
        <div className="ve-path-empty">Pick a preset, or arm ✚ and click the preview to draw the path.</div>
      )}
    </div>
  );
}

/**
 * Grid for laying fields out side by side.
 *
 * The column count rides in a custom property rather than an inline
 * grid-template-columns so the stylesheet stays in charge of layout: the field
 * skin collapses grids of *labelled* fields into one field per row (label left,
 * value right) while grids of bare controls — the X/Y/Z axis triplets — keep
 * their columns.
 */
export function FieldGrid({ cols = 2, children, style }) {
  return (
    <div className="ve-field-grid" style={{ '--ve-field-cols': cols, ...style }}>
      {children}
    </div>
  );
}
