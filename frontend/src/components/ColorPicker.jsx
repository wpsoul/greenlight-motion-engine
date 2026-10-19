import { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Pipette, ClipboardCopy, Ban } from 'lucide-react';
import { useColorTokens } from './colorTokens';

export const COLOR_PRESETS = [
  "#ef4444", "#f97316", "#f59e0b", "#eab308", "#84cc16",
  "#22c55e", "#10b981", "#14b8a6", "#06b6d4", "#0ea5e9",
  "#3b82f6", "#6366f1", "#8b5cf6", "#a855f7", "#d946ef",
  "#ec4899", "#f43f5e", "#78716c", "#6b7280", "#94a3b8",
];

function canUseEyeDropper() {
  return typeof window !== 'undefined' && typeof window.EyeDropper === 'function';
}

// ── Color conversion helpers ──

function hexToHsva(hex) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  const s = max === 0 ? 0 : d / max;
  const v = max;
  let hue = 0;
  if (d !== 0) {
    if (max === r) hue = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) hue = ((b - r) / d + 2) / 6;
    else hue = ((r - g) / d + 4) / 6;
  }
  return { h: hue * 360, s, v, a: 1 };
}

function hsvaToHex(h, s, v) {
  const hh = h / 60;
  const c = v * s;
  const x = c * (1 - Math.abs(hh % 2 - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (hh >= 0 && hh < 1) { r = c; g = x; }
  else if (hh < 2) { r = x; g = c; }
  else if (hh < 3) { g = c; b = x; }
  else if (hh < 4) { g = x; b = c; }
  else if (hh < 5) { r = x; b = c; }
  else { r = c; b = x; }
  const toHex = (n) => Math.round((n + m) * 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function parseColor(value) {
  if (!value || typeof value !== 'string') return { hex: '#ffffff', alpha: 1 };
  const v = value.trim();
  const hex8 = /^#([0-9a-fA-F]{8})$/;
  const hex6 = /^#([0-9a-fA-F]{6})$/;
  const hex3 = /^#([0-9a-fA-F]{3})$/;
  const rgba = /^rgba?\(([^)]+)\)$/i;
  if (hex8.test(v)) {
    return { hex: '#' + v.slice(1, 7).toLowerCase(), alpha: parseInt(v.slice(7, 9), 16) / 255 };
  }
  if (hex6.test(v)) return { hex: v.toLowerCase(), alpha: 1 };
  if (hex3.test(v)) {
    const [, n] = v.match(hex3);
    return { hex: `#${n[0]}${n[0]}${n[1]}${n[1]}${n[2]}${n[2]}`.toLowerCase(), alpha: 1 };
  }
  const m = v.match(rgba);
  if (m) {
    const p = m[1].split(',').map((s) => s.trim());
    const r = Math.round(Math.max(0, Math.min(255, +p[0] || 0)));
    const g = Math.round(Math.max(0, Math.min(255, +p[1] || 0)));
    const b = Math.round(Math.max(0, Math.min(255, +p[2] || 0)));
    const a = p.length >= 4 ? Math.max(0, Math.min(1, +p[3] || 0)) : 1;
    return { hex: `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`, alpha: a };
  }
  return { hex: '#ffffff', alpha: 1 };
}

function formatOutput(hex, alpha, withAlpha) {
  if (!withAlpha || alpha >= 0.999) return hex;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`;
}

// ── Drag helper ──

function useDrag(onMove) {
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;

  const start = useCallback((e) => {
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    onMoveRef.current(e, rect);
    const move = (ev) => onMoveRef.current(ev, rect);
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }, []);

  return start;
}

// ── Main component ──

export default function ColorPicker({
  value,
  onChange,
  onClear,
  withAlpha = false,
  embedded = false,
  presets = COLOR_PRESETS,
  popoverPlacement = 'start',
  // No colour is set (the owning feature is off). The row then shows a "none"
  // swatch and a blank value instead of the fallback colour it would otherwise
  // paint — a white dot next to a disabled border reads as "border: white".
  // Picking, typing or pipetting a colour still emits, which is how it turns on.
  empty = false,
  // what an empty row says ("None" by default; "Default" where unset falls back to a stylesheet colour)
  emptyLabel = 'None',
  // The project's design tokens ride above `presets` in every picker. Turned off
  // inside the Design Tokens editor itself, where a palette of the very swatches
  // being edited reads as a loop.
  showTokens = true,
}) {
  const colorTokens = useColorTokens();
  const tokens = showTokens ? colorTokens : [];
  const { hex, alpha: parsedAlpha } = parseColor(value);
  const [open, setOpen] = useState(false);
  const [hsva, setHsva] = useState(() => ({ ...hexToHsva(hex), a: parsedAlpha }));
  const [pickingColor, setPickingColor] = useState(false);
  const [copied, setCopied] = useState(false);
  const wrapRef = useRef(null);
  const popRef = useRef(null);

  // Sync external value changes
  useEffect(() => {
    const { hex: newHex, alpha: newA } = parseColor(value);
    const newHsva = hexToHsva(newHex);
    setHsva((prev) => {
      // Only update if the resulting color is actually different
      const prevHex = hsvaToHex(prev.h, prev.s, prev.v);
      if (prevHex === newHex && Math.abs(prev.a - newA) < 0.005) return prev;
      return { ...newHsva, a: newA };
    });
  }, [value]);

  // Close on outside click. The panel is portaled to <body>, so it is not inside
  // wrapRef any more — it has to be checked separately or picking a colour would
  // close the thing you are picking in.
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (wrapRef.current?.contains(e.target)) return;
      if (popRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  /* The panel is rendered into <body> at fixed coordinates instead of absolutely
     inside the trigger. Anchored in place it gets clipped by whatever scrolls —
     in a 3-up colour grid the panel is three times wider than its own cell, and
     the inspector's scroll container cut it in half. */
  const [popPos, setPopPos] = useState(null);
  useLayoutEffect(() => {
    if (!open || embedded) { setPopPos(null); return undefined; }
    const compute = () => {
      const el = wrapRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const w = popRef.current?.offsetWidth || 236;
      const h = popRef.current?.offsetHeight || 300;
      const gap = 5;
      const openUp = window.innerHeight - r.bottom < h + gap + 8 && r.top > window.innerHeight - r.bottom;
      const rawLeft = popoverPlacement === 'end' ? r.right - w : r.left;
      setPopPos({
        left: Math.max(8, Math.min(window.innerWidth - w - 8, rawLeft)),
        top: openUp ? null : Math.min(r.bottom + gap, window.innerHeight - h - 8),
        bottom: openUp ? window.innerHeight - r.top + gap : null,
      });
    };
    compute();
    // A second pass once the panel has real dimensions to measure.
    const raf = requestAnimationFrame(compute);
    window.addEventListener('resize', compute);
    window.addEventListener('scroll', compute, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', compute);
      window.removeEventListener('scroll', compute, true);
    };
  }, [open, embedded, popoverPlacement]);

  const emit = useCallback((h, s, v, a) => {
    const newHex = hsvaToHex(h, s, v);
    onChange(formatOutput(newHex, a, withAlpha));
  }, [onChange, withAlpha]);

  const currentHex = hsvaToHex(hsva.h, hsva.s, hsva.v);
  const alpha = withAlpha ? hsva.a : 1;

  // SV area drag
  const svDrag = useDrag((e, rect) => {
    const s = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const v = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / rect.height));
    setHsva((prev) => ({ ...prev, s, v }));
    emit(hsva.h, s, v, alpha);
  });

  // Hue bar drag
  const hueDrag = useDrag((e, rect) => {
    const h = Math.max(0, Math.min(360, ((e.clientX - rect.left) / rect.width) * 360));
    setHsva((prev) => ({ ...prev, h }));
    emit(h, hsva.s, hsva.v, alpha);
  });

  // Alpha bar drag
  const alphaDrag = useDrag((e, rect) => {
    const a = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    setHsva((prev) => ({ ...prev, a }));
    emit(hsva.h, hsva.s, hsva.v, a);
  });

  /* Apply a swatch. A bare 6/3-digit hex carries no alpha, so the picker's
     current alpha is kept (long-standing preset behaviour); a token written as
     rgba()/#rrggbbaa brings its own transparency with it. */
  const applySwatch = useCallback((raw) => {
    const parsed = parseColor(raw);
    const carriesAlpha = /^#[0-9a-fA-F]{8}$/.test(raw.trim()) || /^rgba\(/i.test(raw.trim());
    const nextAlpha = withAlpha && carriesAlpha ? parsed.alpha : alpha;
    const next = hexToHsva(parsed.hex);
    setHsva({ ...next, a: nextAlpha });
    emit(next.h, next.s, next.v, nextAlpha);
  }, [alpha, emit, withAlpha]);

  const [hexInputDraft, setHexInputDraft] = useState(null);
  const handleHexInput = (e) => {
    const raw = e.target.value;
    setHexInputDraft(raw);
    // Try parsing as hex or rgba
    const parsed = parseColor(raw);
    if (parsed && /^#[0-9a-f]{6}$/i.test(parsed.hex)) {
      const next = hexToHsva(parsed.hex);
      const nextAlpha = withAlpha ? parsed.alpha : alpha;
      setHsva({ ...next, a: nextAlpha });
      emit(next.h, next.s, next.v, nextAlpha);
    }
  };
  const handleHexBlur = () => setHexInputDraft(null);

  const handleEyeDropper = useCallback(async () => {
    if (!canUseEyeDropper() || pickingColor) return;
    setPickingColor(true);
    try {
      const eyeDropper = new window.EyeDropper();
      const result = await eyeDropper.open();
      if (!result?.sRGBHex) return;
      const next = hexToHsva(result.sRGBHex);
      setHsva({ ...next, a: alpha });
      emit(next.h, next.s, next.v, alpha);
    } catch (error) {
      if (error?.name !== 'AbortError') {
        console.error('EyeDropper failed', error);
      }
    } finally {
      setPickingColor(false);
    }
  }, [alpha, emit, pickingColor]);

  const handleCopyColor = useCallback(() => {
    const colorStr = withAlpha && alpha < 0.999 ? formatOutput(currentHex, alpha, true) : currentHex;
    navigator.clipboard.writeText(colorStr).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }).catch(() => {});
  }, [currentHex, alpha, withAlpha]);

  const displayValue = withAlpha && alpha < 0.999 ? formatOutput(currentHex, alpha, true) : currentHex;

  const panel = (
    <div
      className={`cp-popover ${popoverPlacement === 'end' ? 'cp-popover-end' : ''} ${embedded ? 'cp-popover-embedded' : ''}`.trim()}
      ref={embedded ? null : popRef}
    >
      <div
        className="cp-sv"
        style={{ background: `hsl(${hsva.h}, 100%, 50%)` }}
        onMouseDown={svDrag}
      >
        <div className="cp-sv-white" />
        <div className="cp-sv-black" />
        <div
          className="cp-sv-cursor"
          style={{ left: `${hsva.s * 100}%`, top: `${(1 - hsva.v) * 100}%` }}
        />
      </div>

      <div className="cp-bar cp-hue-bar" onMouseDown={hueDrag}>
        <div className="cp-bar-cursor" style={{ left: `${(hsva.h / 360) * 100}%` }} />
      </div>

      {withAlpha && (
        <div className="cp-bar cp-alpha-bar" onMouseDown={alphaDrag}>
          <div className="cp-alpha-gradient" style={{
            background: `linear-gradient(to right, transparent, ${currentHex})`
          }} />
          <div className="cp-bar-cursor" style={{ left: `${alpha * 100}%` }} />
        </div>
      )}

      {/* Project design tokens: the first row, above the fixed palette. */}
      {tokens.length > 0 && (
        <div className="cp-tokens">
          <div className="cp-presets">
            {tokens.map((token, i) => (
              <button
                key={`${token}-${i}`}
                type="button"
                className={`cp-preset-swatch cp-token-swatch${parseColor(token).hex === currentHex.toLowerCase() ? ' active' : ''}`}
                style={{ background: token }}
                onClick={() => applySwatch(token)}
                title={`Project token · ${token}`}
                aria-label={`Use project token ${token}`}
              />
            ))}
          </div>
        </div>
      )}

      {presets && presets.length > 0 && (
        <div className="cp-presets">
          {presets.map((preset) => (
            <button
              key={preset}
              type="button"
              className={`cp-preset-swatch${preset.toLowerCase() === currentHex.toLowerCase() ? ' active' : ''}`}
              style={{ background: preset }}
              onClick={() => applySwatch(preset)}
              title={preset}
              aria-label={`Use color ${preset}`}
            />
          ))}
        </div>
      )}

      <div className="cp-inputs">
        <input
          type="text"
          className="cp-hex-input"
          value={hexInputDraft !== null ? hexInputDraft : displayValue}
          onChange={handleHexInput}
          onBlur={handleHexBlur}
          spellCheck={false}
          autoComplete="off"
        />
        <button
          type="button"
          className="cp-tool-btn cp-tool-btn-inline"
          onClick={handleEyeDropper}
          disabled={!canUseEyeDropper() || pickingColor}
          title={pickingColor ? 'Picking color...' : 'Pick color from screen'}
          aria-label={pickingColor ? 'Picking color' : 'Pick color from screen'}
        >
          {pickingColor ? (
            <span className="cp-tool-spinner" />
          ) : (
            <Pipette size={14} aria-hidden="true" />
          )}
        </button>
        <button
          type="button"
          className={`cp-tool-btn cp-tool-btn-inline${copied ? ' cp-copied' : ''}`}
          onClick={handleCopyColor}
          title={copied ? 'Copied!' : 'Copy color'}
          aria-label="Copy color to clipboard"
        >
          <ClipboardCopy size={14} aria-hidden="true" />
        </button>
        {onClear && (
          <button
            type="button"
            className="cp-tool-btn cp-tool-btn-inline"
            onClick={onClear}
            title="Clear color"
            aria-label="Clear color"
          >
            <Ban size={14} aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );

  if (embedded) {
    return panel;
  }

  return (
    <div className={`cp-wrap${open ? ' cp-open' : ''}`} ref={wrapRef}>
      {/* Remove sits at the head of the row and only surfaces on hover — it is
          rare, destructive, and shouldn't sit in the reading path of the value. */}
      {onClear && (
        <button
          type="button"
          className="cp-clear-inline"
          onClick={onClear}
          title="Remove colour"
          aria-label="Remove colour"
        >
          <Ban size={12} aria-hidden="true" />
        </button>
      )}
      <div className="cp-swatch-btn">
        <button
          type="button"
          className="cp-swatch-open"
          onClick={() => setOpen((v) => !v)}
          title={empty ? 'No colour — pick one to add' : displayValue}
          aria-label="Open colour picker"
        >
          <span
            className={`cp-swatch${empty ? ' cp-swatch-none' : ''}`}
            style={empty ? undefined : { background: withAlpha ? `rgba(${parseInt(currentHex.slice(1,3),16)},${parseInt(currentHex.slice(3,5),16)},${parseInt(currentHex.slice(5,7),16)},${alpha})` : currentHex }}
          />
        </button>
        {/* The value is typed, not just displayed — the same field the panel has,
            hoisted onto the row so a known hex never needs the panel at all. */}
        <input
          type="text"
          className="cp-swatch-label"
          spellCheck={false}
          value={hexInputDraft !== null ? hexInputDraft : (empty ? '' : displayValue)}
          placeholder={empty ? emptyLabel : undefined}
          onChange={handleHexInput}
          onBlur={handleHexBlur}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            else if (e.key === 'Escape') { setHexInputDraft(null); e.currentTarget.blur(); }
          }}
          aria-label="Colour value"
          autoComplete="off"
        />
      </div>
      {/* Screen-pick without opening the panel first. Hidden by default; the
          video editor's colour rows opt in via CSS (.cp-inline-pipette), so the
          other surfaces that embed this picker keep the trigger they had. */}
      {canUseEyeDropper() && (
        <button
          type="button"
          className={`cp-inline-pipette${pickingColor ? ' picking' : ''}`}
          onClick={handleEyeDropper}
          disabled={pickingColor}
          title={pickingColor ? 'Picking colour…' : 'Pick colour from screen'}
          aria-label="Pick colour from screen"
        >
          <Pipette size={12} aria-hidden="true" />
        </button>
      )}
      {open && popPos && createPortal(
        <div
          className="cp-portal"
          style={{
            position: 'fixed',
            left: popPos.left,
            top: popPos.top ?? undefined,
            bottom: popPos.bottom ?? undefined,
            zIndex: 100020,
          }}
        >
          {panel}
        </div>,
        document.body,
      )}
    </div>
  );
}
