/*
 * The pictures of the 3D inspectors. The light map is a PLAN VIEW read like a map —
 * up is behind the subject, down is toward the camera. The camera's own map is
 * cameraMoveMap.jsx.
 *
 *   RigLightMap     every light of the rig at once (the old single-light dial's
 *                   convention: centre = overhead, dashed ring = horizon, rim =
 *                   underneath). Drag a light to aim it.
 *   FocusPad        the frame, the focus point and the sharp area.
 */

const POSITIONLESS = new Set(['ambient', 'hemisphere']);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function svgPoint(svg, e) {
  const r = svg.getBoundingClientRect();
  const vb = svg.viewBox.baseVal;
  return { x: ((e.clientX - r.left) / r.width) * vb.width, y: ((e.clientY - r.top) / r.height) * vb.height };
}

/** Drag on an svg: `onDrag(point, first)` per move, pointer captured on the svg. */
function beginSvgDrag(e, onDrag, onEnd) {
  const svg = e.currentTarget;
  e.preventDefault();
  svg.setPointerCapture?.(e.pointerId);
  let first = true;
  const move = (ev) => { onDrag(svgPoint(svg, ev), first); first = false; };
  const up = () => {
    svg.removeEventListener('pointermove', move);
    svg.removeEventListener('pointerup', up);
    svg.removeEventListener('pointercancel', up);
    onEnd?.();
  };
  svg.addEventListener('pointermove', move);
  svg.addEventListener('pointerup', up);
  svg.addEventListener('pointercancel', up);
}

// ── lights ─────────────────────────────────────────────────────────────────
const LW = 224;
const LH = 170;
const LC = { x: LW / 2, y: LH / 2 };
const LR = LH / 2 - 16;

const lightXY = (az, elev) => {
  const r = LR * (1 - (clamp(Number(elev) || 0, -90, 90) + 90) / 180);
  const a = ((Number(az) || 0) * Math.PI) / 180;
  return { x: LC.x + Math.sin(a) * r, y: LC.y + Math.cos(a) * r };
};

function BackdropSketch({ cyclorama }) {
  const shape = cyclorama?.shape || 'none';
  if (shape === 'none') return null;
  const s = LR * 0.27;
  const { x, y } = LC;
  const back = y - s * 0.62;
  const color = cyclorama?.material?.color || '#d8d8d8';
  const fillOpacity = cyclorama?.material?.mode === 'shadowCatcher' ? 0.03 : 0.08;
  const line = { stroke: '#3f474b', strokeWidth: 1.5, fill: 'none' };
  const filled = { stroke: '#3f474b', strokeWidth: 1.5, fill: color, fillOpacity };
  switch (shape) {
    case 'cyc':
      return (
        <>
          <path d={`M${x - s} ${y + s * 0.55} H${x + s} V${back + s * 0.3} Q${x + s} ${back} ${x + s * 0.7} ${back} H${x - s * 0.7} Q${x - s} ${back} ${x - s} ${back + s * 0.3} Z`} fill={color} fillOpacity={fillOpacity} />
          <path d={`M${x - s} ${y + s * 0.55} V${back + s * 0.3} Q${x - s} ${back} ${x - s * 0.7} ${back} H${x + s * 0.7} Q${x + s} ${back} ${x + s} ${back + s * 0.3} V${y + s * 0.55}`} {...line} />
        </>
      );
    case 'floor': return <rect x={x - s} y={back} width={2 * s} height={s * 1.2} rx="2" {...filled} />;
    case 'wall': return <path d={`M${x - s} ${back} H${x + s}`} stroke="#5a6266" strokeWidth="3" strokeLinecap="round" />;
    case 'corner': return <path d={`M${x - s} ${y + s * 0.4} V${back} H${x + s}`} {...line} />;
    case 'room': return <rect x={x - s} y={back} width={2 * s} height={s * 1.25} {...filled} />;
    case 'dome':
      return (
        <>
          <circle cx={x} cy={y} r={s * 0.95} {...filled} />
          <circle cx={x} cy={y} r={s * 0.55} fill="none" stroke="#3a4145" strokeDasharray="2 3" />
        </>
      );
    case 'disc': return <circle cx={x} cy={y} r={s * 0.8} {...filled} />;
    default: return <circle cx={x} cy={y} r={s * 0.95} {...filled} />; // cylinder
  }
}

export function RigLightMap({ lights = [], cyclorama = null, selectedLid = null, lockedLids = null, onSelect, onMove }) {
  const selected = lights.find((l) => l.lid === selectedLid) || null;
  const onPointerDown = (e) => {
    const hit = e.target.closest?.('[data-lid]');
    if (!hit) return;
    const lid = hit.getAttribute('data-lid');
    onSelect?.(lid);
    if (lockedLids?.has(lid)) return;
    beginSvgDrag(e, (p, first) => {
      const dx = p.x - LC.x;
      const dy = p.y - LC.y;
      const dist = Math.min(LR, Math.hypot(dx, dy));
      // atan2(dx, dy) with screen-down dy: 6 o'clock = 0 (in front), 3 o'clock = 90
      // (camera-right), 12 o'clock = 180 (behind) — the inverse of lightXY.
      onMove?.(lid, Math.round((Math.atan2(dx, dy) * 180) / Math.PI), Math.round(90 - (dist / LR) * 180), !first);
    });
  };
  const fills = lights.filter((l) => POSITIONLESS.has(l.type));
  return (
    <div className="ve-scene-map ve-scene-light-map">
      <svg viewBox={`0 0 ${LW} ${LH + 8}`} onPointerDown={onPointerDown} role="img" aria-label="Light map — drag a light to aim it">
        <circle cx={LC.x} cy={LC.y} r={LR} fill="#15181a" stroke="#262b2e" />
        <circle cx={LC.x} cy={LC.y} r={LR / 2} fill="none" stroke="#30373b" strokeDasharray="2 3" />
        <line x1={LC.x} y1={LC.y - LR} x2={LC.x} y2={LC.y + LR} stroke="#1f2427" />
        <line x1={LC.x - LR} y1={LC.y} x2={LC.x + LR} y2={LC.y} stroke="#1f2427" />
        <text x={LC.x} y={LC.y - LR - 5} textAnchor="middle" className="ve-scene-map-tick">BACK</text>
        <BackdropSketch cyclorama={cyclorama} />
        {lights.filter((l) => !POSITIONLESS.has(l.type)).map((l) => {
          const p = lightXY(l.az, l.elev);
          const alpha = l.on ? Math.min(0.5, 0.12 + (Number(l.intensity) || 0) * 0.18) : 0.06;
          const ang = Math.atan2(LC.y - p.y, LC.x - p.x);
          const len = Math.hypot(LC.x - p.x, LC.y - p.y) + 10;
          const half = (Math.min(60, Number(l.angle) || 30) * Math.PI) / 180;
          return (
            <g key={`b-${l.lid}`} pointerEvents="none">
              {l.type === 'spot' && (
                <path
                  d={`M${p.x} ${p.y} L${p.x + Math.cos(ang - half) * len} ${p.y + Math.sin(ang - half) * len} L${p.x + Math.cos(ang + half) * len} ${p.y + Math.sin(ang + half) * len} Z`}
                  fill={l.color} fillOpacity={alpha * 0.45}
                />
              )}
              {l.type === 'point' && <circle cx={p.x} cy={p.y} r={16 + (Number(l.intensity) || 0) * 6} fill={l.color} fillOpacity={alpha * 0.35} />}
              {l.type === 'area' && (
                <path
                  d={`M${p.x - Math.sin(ang) * 9} ${p.y + Math.cos(ang) * 9} L${p.x + Math.sin(ang) * 9} ${p.y - Math.cos(ang) * 9} L${LC.x + Math.sin(ang) * 4} ${LC.y - Math.cos(ang) * 4} L${LC.x - Math.sin(ang) * 4} ${LC.y + Math.cos(ang) * 4} Z`}
                  fill={l.color} fillOpacity={alpha * 0.4}
                />
              )}
              <line x1={p.x} y1={p.y} x2={LC.x} y2={LC.y} stroke={l.color} strokeOpacity={alpha} strokeWidth={1 + Math.min(4, (Number(l.intensity) || 0) * 2.2)} strokeLinecap="round" />
            </g>
          );
        })}
        <rect x={LC.x - 6} y={LC.y - 8} width="12" height="16" rx="3" fill="#e8ebea" pointerEvents="none" />
        <g transform={`translate(${LC.x} ${LC.y + LR + 9})`} fill="none" stroke="#7d8582" strokeWidth="1.3" strokeLinejoin="round" pointerEvents="none">
          <rect x="-7" y="-3.5" width="10" height="7" rx="1.5" />
          <path d="M3 -1.5 7 -3.5v7L3 1.5" />
        </g>
        {lights.filter((l) => !POSITIONLESS.has(l.type)).map((l) => {
          const p = lightXY(l.az, l.elev);
          const isSel = l.lid === selectedLid;
          const locked = lockedLids?.has(l.lid);
          const dx = p.x - LC.x;
          const dy = p.y - LC.y;
          const d = Math.hypot(dx, dy);
          const ux = d < 4 ? 0 : dx / d;
          const uy = d < 4 ? -1 : dy / d;
          return (
            <g key={l.lid} data-lid={l.lid} className={`ve-scene-map-puck${locked ? ' is-locked' : ''}`}>
              <title>{locked ? `${l.name} — aimed by keyframes` : `${l.name} — drag to aim`}</title>
              {isSel && <circle cx={p.x} cy={p.y} r="10.5" fill="none" stroke="#eef2f0" strokeWidth="1.3" />}
              <circle
                cx={p.x} cy={p.y} r="6.5"
                fill={l.on ? l.color : '#151718'}
                stroke={l.on ? 'rgba(0,0,0,.55)' : '#6f7773'}
                strokeWidth="1.2"
                strokeDasharray={Number(l.elev) < 0 ? '2 2' : undefined}
              />
              <circle cx={p.x} cy={p.y} r="14" fill="transparent" />
              <text
                x={p.x + ux * 13} y={p.y + uy * 13 + 3}
                textAnchor={ux > 0.35 ? 'start' : ux < -0.35 ? 'end' : 'middle'}
                className={`ve-scene-map-label${isSel ? ' is-sel' : ''}`}
              >
                {l.name}
              </text>
            </g>
          );
        })}
      </svg>
      {selected && !POSITIONLESS.has(selected.type) && (
        <div className="ve-scene-map-hud">{selected.name}<br />{Math.round(selected.az)}° · {Math.round(selected.elev)}° up</div>
      )}
      {fills.length > 0 && (
        <div className="ve-scene-map-chips">
          {fills.map((l) => (
            <button
              key={l.lid}
              type="button"
              className={`ve-scene-map-chip${l.lid === selectedLid ? ' is-sel' : ''}${l.on ? '' : ' is-off'}`}
              title={`${l.name} lights the whole set evenly`}
              onClick={() => onSelect?.(l.lid)}
            >
              <i style={{ background: l.color }} />
              {l.name} {Number(Number(l.intensity).toFixed(2))}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── focus ──────────────────────────────────────────────────────────────────
const FW = 224;
const FH = 126;

export function FocusPad({ x = 50, y = 50, width = 0, aperture = 24, blurLevel = 100, disabled = false, onMove }) {
  const fx = (clamp(x, 0, 100) / 100) * FW;
  const fy = (clamp(y, 0, 100) / 100) * FH;
  const rr = (Math.max(0, width) / 100) * FW * 0.5;
  const blur = Math.min(6, (Math.max(0, aperture) / 24) * 2.2 * (Math.max(0, blurLevel) / 100));
  const onPointerDown = (e) => {
    if (disabled || !onMove) return;
    const svg = e.currentTarget;
    const write = (p, coalesce) => onMove(
      Math.round(clamp((p.x / FW) * 100, 0, 100)),
      Math.round(clamp((p.y / FH) * 100, 0, 100)),
      coalesce,
    );
    write(svgPoint(svg, e), false);
    beginSvgDrag(e, (p) => write(p, true));
  };
  return (
    <div className={`ve-scene-map ve-scene-focus-pad${disabled ? ' is-locked' : ''}`} title={disabled ? 'The focus point is keyframed' : 'Drag to move the focus point'}>
      <svg viewBox={`0 0 ${FW} ${FH}`} onPointerDown={onPointerDown} role="img" aria-label="Focus point">
        <defs>
          <filter id="ve-scene-focus-blur" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation={blur.toFixed(2)} />
          </filter>
        </defs>
        <rect x={FW * 0.12} y={FH * 0.18} width={FW * 0.22} height={FH * 0.5} rx="4" fill="#3a4145" filter="url(#ve-scene-focus-blur)" />
        <rect x={FW * 0.66} y={FH * 0.28} width={FW * 0.2} height={FH * 0.46} rx="4" fill="#2c3236" filter="url(#ve-scene-focus-blur)" />
        <rect x={FW * 0.42} y={FH * 0.3} width={FW * 0.16} height={FH * 0.44} rx="5" fill="#e8ebea" />
        {rr > 0 && <ellipse cx={fx} cy={fy} rx={rr} ry={rr * 0.75} fill="none" stroke="#33efab" strokeOpacity="0.55" strokeDasharray="3 3" />}
        <g stroke="#33efab" strokeWidth="1.4" fill="none">
          <circle cx={fx} cy={fy} r="7" />
          <path d={`M${fx} ${fy - 12}v5M${fx} ${fy + 7}v5M${fx - 12} ${fy}h5M${fx + 7} ${fy}h5`} />
        </g>
      </svg>
    </div>
  );
}
