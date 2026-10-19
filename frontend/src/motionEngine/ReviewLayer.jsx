/*
 * The marks of review notes, drawn over the preview in composition pixels (it sits inside .glm-frame, so it scales
 * with the picture), and — while `active` — the place the viewer draws a new one: a pin is a click, a box, an arrow
 * or a drawing is a drag. reviewNotes.js holds the model; PlayerPage.jsx decides where a finished mark goes.
 */
import { useRef, useState } from 'react';
import { MARK_COLOR, isStray } from './reviewNotes';

function Mark({ mark, n, k, pin = true, dim = false }) {
  const w = 3 * k;
  const common = { stroke: MARK_COLOR, strokeWidth: w, fill: 'none', strokeLinecap: 'round', strokeLinejoin: 'round', opacity: dim ? 0.55 : 1 };
  const badge = (x, y) => (pin && n != null ? (
    <g className="glm-rv-pin" transform={`translate(${x} ${y})`}>
      <circle r={15 * k} fill={MARK_COLOR} stroke="#fff" strokeWidth={2 * k} />
      <text y={5.5 * k} textAnchor="middle" fontSize={16 * k} fontWeight="700" fill="#fff">{n}</text>
    </g>
  ) : null);
  if (mark.kind === 'pin') {
    if (n == null) return <circle cx={mark.x} cy={mark.y} r={15 * k} fill={MARK_COLOR} stroke="#fff" strokeWidth={2 * k} />;
    return badge(mark.x, mark.y);
  }
  if (mark.kind === 'box') {
    const x = Math.min(mark.x1, mark.x2); const y = Math.min(mark.y1, mark.y2);
    return (
      <g>
        <rect x={x} y={y} width={Math.abs(mark.x2 - mark.x1)} height={Math.abs(mark.y2 - mark.y1)} rx={6 * k} {...common} fill="rgba(255,77,79,0.08)" />
        {badge(x, y)}
      </g>
    );
  }
  if (mark.kind === 'arrow') {
    const a = Math.atan2(mark.y2 - mark.y1, mark.x2 - mark.x1); const h = 18 * k;
    const p1 = [mark.x2 - h * Math.cos(a - 0.45), mark.y2 - h * Math.sin(a - 0.45)];
    const p2 = [mark.x2 - h * Math.cos(a + 0.45), mark.y2 - h * Math.sin(a + 0.45)];
    return (
      <g>
        <line x1={mark.x1} y1={mark.y1} x2={mark.x2} y2={mark.y2} {...common} />
        <polygon points={`${mark.x2},${mark.y2} ${p1[0]},${p1[1]} ${p2[0]},${p2[1]}`} fill={MARK_COLOR} opacity={common.opacity} />
        {badge(mark.x1, mark.y1)}
      </g>
    );
  }
  const d = mark.pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  return (
    <g>
      <path d={d} {...common} />
      {badge(mark.pts[0][0], mark.pts[0][1])}
    </g>
  );
}

/**
 * size: the composition; scale: screen px per composition px (marks keep their on-screen weight at any zoom);
 * shown: [{ key, n, mark, pin, dim }]; active + tool: drawing; onFinish(mark): a finished, non-stray mark.
 */
export function ReviewLayer({ size, scale = 1, shown = [], active = false, tool = 'pin', onFinish }) {
  const ref = useRef(null);
  const [draft, setDraft] = useState(null);
  const k = 1 / Math.max(0.05, scale);
  const toComp = (e) => {
    const r = ref.current.getBoundingClientRect();
    return [((e.clientX - r.left) / Math.max(1e-6, r.width)) * size.w, ((e.clientY - r.top) / Math.max(1e-6, r.height)) * size.h];
  };
  const down = (e) => {
    if (!active || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const [x, y] = toComp(e);
    if (tool === 'pin') { onFinish?.({ kind: 'pin', x, y }, e); return; }
    ref.current.setPointerCapture?.(e.pointerId);
    setDraft(tool === 'pen' ? { kind: 'pen', pts: [[x, y]] } : { kind: tool, x1: x, y1: y, x2: x, y2: y });
  };
  const move = (e) => {
    if (!draft) return;
    const [x, y] = toComp(e);
    setDraft((d) => {
      if (!d) return d;
      if (d.kind !== 'pen') return { ...d, x2: x, y2: y };
      const [lx, ly] = d.pts[d.pts.length - 1];
      return Math.hypot(x - lx, y - ly) < 2 * k ? d : { ...d, pts: [...d.pts, [x, y]] };
    });
  };
  const up = (e) => {
    if (!draft) return;
    const d = draft;
    setDraft(null);
    if (!isStray(d, 6 * k)) onFinish?.(d, e);
  };
  return (
    <svg
      ref={ref}
      className={`glm-review${active ? ' is-active' : ''} t-${tool}`}
      viewBox={`0 0 ${size.w} ${size.h}`}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={() => setDraft(null)}
      aria-hidden={!active}
      data-review-layer=""
    >
      {shown.map((s) => <Mark key={s.key} mark={s.mark} n={s.n} k={k} pin={s.pin !== false} dim={s.dim} />)}
      {draft && <Mark mark={draft} k={k} pin={false} />}
    </svg>
  );
}
