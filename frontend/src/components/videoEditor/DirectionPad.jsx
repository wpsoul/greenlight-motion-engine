import { useRef } from 'react';
import { DIRECTION_VECTOR, DIRECTION_LABEL, nearestDirection } from './presetDirections';

/*
 * The direction pad for directional presets (presetDirections.js) — the transition builder's move pad
 * (TransitionBuilder.jsx `renderPad`, the same grid and dashed arrow) snapped to the directions a preset offers:
 * click, drag or press an arrow key, and the arrow points where the layer will TRAVEL. Faint marks show the choices.
 */
export default function DirectionPad({ value, options, onChange, size = 72 }) {
  const ref = useRef(null);
  const dragging = useRef(false);

  const pick = (e) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const x = ((e.clientX - r.left) / r.width) * 2 - 1;
    const y = ((e.clientY - r.top) / r.height) * 2 - 1;
    if (Math.hypot(x, y) < 0.12) return;   // the centre means nothing
    const next = nearestDirection(x, y, options);
    if (next !== value) onChange?.(next);
  };
  const onKeyDown = (e) => {
    const want = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (!want) return;
    e.preventDefault();
    e.stopPropagation();
    // from the current direction, nudge toward the key (so diagonals can be reached with two presses)
    const [cx, cy] = DIRECTION_VECTOR[value] || [0, 0];
    const next = nearestDirection(cx * 0.4 + want[0], cy * 0.4 + want[1], options);
    if (next !== value) onChange?.(next);
  };

  const at = (d, reach) => {
    const [vx, vy] = DIRECTION_VECTOR[d];
    const len = Math.hypot(vx, vy);
    return [50 + (vx / len) * reach, 50 + (vy / len) * reach];
  };
  const [ex, ey] = value && DIRECTION_VECTOR[value] ? at(value, 34) : [50, 50];

  return (
    <div
      ref={ref}
      className="ve-dirpad"
      style={{ width: size, height: size }}
      role="radiogroup"
      aria-label="Direction"
      tabIndex={0}
      title={`Travels ${DIRECTION_LABEL[value] || ''} — click, drag or use the arrow keys`}
      onKeyDown={onKeyDown}
      onPointerDown={(e) => { dragging.current = true; e.currentTarget.setPointerCapture?.(e.pointerId); pick(e); }}
      onPointerMove={(e) => { if (dragging.current) pick(e); }}
      onPointerUp={() => { dragging.current = false; }}
    >
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        {[25, 75].map((q) => (
          <g key={q}>
            <line className="ve-dirpad-line" x1={q} y1="0" x2={q} y2="100" />
            <line className="ve-dirpad-line" x1="0" y1={q} x2="100" y2={q} />
          </g>
        ))}
        <line className="ve-dirpad-center" x1="50" y1="0" x2="50" y2="100" />
        <line className="ve-dirpad-center" x1="0" y1="50" x2="100" y2="50" />
        {options.map((d) => {
          const [mx, my] = at(d, 38);
          return <circle key={d} className={`ve-dirpad-mark${d === value ? ' on' : ''}`} cx={mx} cy={my} r="3.2" />;
        })}
        <defs>
          <marker id="ve-dirpad-arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto" markerUnits="strokeWidth">
            <path d="M0,0 L6,3 L0,6 z" fill="var(--accent)" />
          </marker>
        </defs>
        {value && (
          <line x1="50" y1="50" x2={ex} y2={ey} stroke="var(--accent)" strokeWidth="1.6" strokeDasharray="4 2"
            markerEnd="url(#ve-dirpad-arrow)" vectorEffect="non-scaling-stroke" />
        )}
      </svg>
    </div>
  );
}
