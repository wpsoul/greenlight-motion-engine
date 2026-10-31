import { useCallback, useRef } from "react";
import { createPortal } from "react-dom";

// Shared "Soft Pill" hover tooltip for media thumbnails. Shows a name, a size
// and — for media with a timeline — its running length, instantly above the
// hovered element, replacing the slow native `title`. The tooltip is rendered
// through a body portal and positioned with position:fixed so it escapes grid
// overflow clipping and any ancestor backdrop-filter/transform containing block.
// It is driven imperatively (refs, not state) so hovering never re-renders the
// host list.
//
// It is a tooltip and nothing more: actions belong on the tile or in the panel
// footer, never in here — the pill is not hoverable and cannot be clicked.
//
// Usage:
//   const { portal, showTip, hideTip } = useHoverTip();
//   ...
//   <div onMouseEnter={(e) => showTip(e.currentTarget, name, size, length)} onMouseLeave={hideTip} />
//   ...
//   return (<>{portal}{/* rest */}</>);
export function useHoverTip() {
  const tipRef = useRef(null);
  const nameRef = useRef(null);
  const sizeRef = useRef(null);
  const sizeRowRef = useRef(null);
  const metaRef = useRef(null);
  const lengthRef = useRef(null);

  const showTip = useCallback((el, name, size, length) => {
    const tip = tipRef.current;
    if (!tip || !el) return;
    const r = el.getBoundingClientRect();
    if (nameRef.current) nameRef.current.textContent = name || "";
    if (sizeRef.current) sizeRef.current.textContent = size || "";
    // The length rides in its own clock-marked span, hidden when unknown.
    if (lengthRef.current) lengthRef.current.textContent = length || "";
    if (metaRef.current) metaRef.current.hidden = !length;
    // a name-only tip (a menu button, a file name) has no second line at all
    if (sizeRowRef.current) sizeRowRef.current.hidden = !size && !length;
    // Clamp horizontally so a tooltip over an edge item stays fully on screen.
    const margin = 132;
    const cx = Math.max(margin, Math.min(r.left + r.width / 2, window.innerWidth - margin));
    tip.style.left = `${cx}px`;
    tip.style.top = `${Math.round(r.top)}px`;
    tip.classList.add("visible");
  }, []);

  const hideTip = useCallback(() => {
    tipRef.current?.classList.remove("visible");
  }, []);

  const portal = createPortal(
    <div className="media-hover-tip" ref={tipRef} role="tooltip" aria-hidden="true">
      <span className="media-hover-tip-name" ref={nameRef} />
      <span className="media-hover-tip-size" ref={sizeRowRef}>
        <span ref={sizeRef} />
        <span className="media-hover-tip-meta" ref={metaRef} hidden>
          <i className="media-hover-tip-dot" />
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <polyline points="12,7 12,12 15.5,14" />
          </svg>
          <span ref={lengthRef} />
        </span>
      </span>
    </div>,
    document.body
  );

  return { portal, showTip, hideTip };
}
