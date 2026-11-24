import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import {
  CAMERA_NEUTRAL, cameraWorldPosition, evaluateCameraPath, getCameraPose, perspectiveDistance,
} from './projectCamera';
import { cameraRigFromEndpoint, normalizeCameraRig, rigToWorld, sampleCameraRig, worldToRig } from './cameraRig';
import {
  cameraMoveUpdates, dragPathTangent, moveFreeKeys, movePathPoints, propsForWorld,
} from './cameraPathCapture';

/*
 * The camera map: a small 3D view of the set, in every movement mode, with the camera's real route sampled from the
 * evaluators the renderer uses. Points move like they do in the 3D world view: click selects, Shift / ⌘ / Ctrl adds or
 * drops, a press also jumps the playhead to that key so the preview shows the frame being edited, arrows lock an axis,
 * the square slides along the floor, a lone point shows its tangents (Alt breaks the pair), empty space turns the map.
 * The gizmo's rotate and scale live in the 3D view only.
 *
 * Everything a drag needs is in the frame frame3D builds, and a drag holds on to that frame, so the map can't refit
 * under the pointer. Writes are absolute from a snapshot taken at the press.
 */

const MW = 224;
const MH = 204; // the bottom of the picture belongs to the controls laid over it
const CONTROLS_PAD = 42;
const GREEN = '#33efab';
const TEAL = '#74ceae';
const CYAN = '#22d3ee'; // the world view's tangent colour
const AXES = {
  x: { v: { x: 1, y: 0, z: 0 }, color: '#d98b8b' },
  y: { v: { x: 0, y: 1, z: 0 }, color: '#8fc7a0' },
  z: { v: { x: 0, y: 0, z: 1 }, color: '#8fa8d9' },
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const add = (a, b, k = 1) => ({ x: a.x + b.x * k, y: a.y + b.y * k, z: a.z + b.z * k });
const poly = (pts, f) => pts.map((p, i) => { const s = f(p); return `${i ? 'L' : 'M'}${s.x.toFixed(1)} ${s.y.toFixed(1)}`; }).join(' ');
const toWorld = (pose, w, h) => { const v = cameraWorldPosition(pose, w, h); return { x: v.x, y: v.y, z: v.z }; };

function cameraForward(pose) {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(
    -((Number(pose?.camTiltX) || 0) * Math.PI) / 180,
    -((Number(pose?.camTiltY) || 0) * Math.PI) / 180,
    -((Number(pose?.camRoll) || 0) * Math.PI) / 180,
    'XYZ',
  )).invert();
  const v = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
  return { x: v.x, y: v.y, z: v.z };
}

function centroid(list) {
  const c = { x: 0, y: 0, z: 0 };
  for (const a of list) { c.x += a.x / list.length; c.y += a.y / list.length; c.z += a.z / list.length; }
  return c;
}

function fit2D(list) {
  const pad = 12;
  const padTop = 14;
  const xs = list.map((a) => a.u);
  const ys = list.map((a) => a.v);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  const k = Math.min((MW - pad * 2) / Math.max(1, x1 - x0), (MH - CONTROLS_PAD - padTop) / Math.max(1, y1 - y0));
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const midY = padTop + (MH - CONTROLS_PAD - padTop) / 2;
  return (u, v) => ({ x: MW / 2 + (u - cx) * k, y: midY + (v - cy) * k });
}

// The camera stands about 2,000 px from the comp, so a true-scale picture of a few hundred px of route is a smudge. Two
// cases deal with that:
//  - a route: the empty distance is shortened, measured from the route. Never from the camera alone, or the camera lands
//    in the same place wherever it is and a dolly shows nothing;
//  - no route: the camera is what there is to see, so its whole world takes one plain scale and a fixed home view.
function frame3D(cam, flown, orbit, W, H) {
  let warp;
  let scale = 1;
  let plate = 1;
  const home = [];
  if (flown.length > 1) {
    const nearZ = Math.min(...flown.map((a) => a.z));
    const farZ = Math.max(...flown.map((a) => a.z));
    const gap = nearZ > 0 ? clamp((farZ - nearZ) * 0.6 + 340, 300, nearZ) : nearZ;
    const shortZ = (z) => (z <= 0 || nearZ <= 0 ? z : z >= nearZ ? z - (nearZ - gap) : (z * gap) / nearZ);
    warp = (a) => ({ x: a.x, y: a.y, z: shortZ(a.z) });
    const span = (list) => Math.max(...list) - Math.min(...list);
    const spread = Math.max(span(flown.map((a) => a.x)), span(flown.map((a) => a.y)) * (W / H), 300);
    plate = clamp((spread * 1.7) / W, 0.28, 1);
  } else {
    const D0 = perspectiveDistance(H);
    scale = (W * 0.8) / D0;
    warp = (a) => ({ x: a.x * scale, y: a.y * scale, z: a.z * scale });
    home.push(warp({ x: 0, y: 0, z: D0 }), warp({ x: 0, y: 0, z: D0 + 500 })); // a little room to dolly out before it refits
  }
  const pw = (W / 2) * plate;
  const ph = (H / 2) * plate;
  const cloud = [{ x: -pw, y: ph, z: 0 }, { x: pw, y: -ph, z: 0 }, ...flown.map(warp), warp(cam), ...home];
  const mid = centroid(cloud);
  let rad = 1;
  for (const a of cloud) rad = Math.max(rad, Math.hypot(a.x - mid.x, a.y - mid.y, a.z - mid.z));
  const D = rad * 3.4;
  const cy = Math.cos(orbit.yaw); const sy = Math.sin(orbit.yaw); const cp = Math.cos(orbit.pitch); const sp = Math.sin(orbit.pitch);
  const proj0 = (a) => {
    const x = a.x - mid.x; const y = a.y - mid.y; const z = a.z - mid.z;
    const x1 = x * cy + z * sy;
    const z1 = -x * sy + z * cy;
    const y1 = y * cp - z1 * sp;
    const z2 = y * sp + z1 * cp;
    const s = D / (D - z2);
    return { u: x1 * s, v: -y1 * s };
  };
  const margin = rad * 0.08;
  const floorY = Math.min(...cloud.map((a) => a.y)) - rad * 0.1;
  const fx0 = Math.min(...cloud.map((a) => a.x)) - margin;
  const fx1 = Math.max(...cloud.map((a) => a.x)) + margin;
  const fz0 = Math.min(...cloud.map((a) => a.z)) - margin;
  const fz1 = Math.max(...cloud.map((a) => a.z)) + margin;
  const corners = [{ x: fx0, y: floorY, z: fz0 }, { x: fx1, y: floorY, z: fz0 }, { x: fx1, y: floorY, z: fz1 }, { x: fx0, y: floorY, z: fz1 }];
  const place = fit2D([...cloud, ...corners].map(proj0));
  const g = (a) => { const q = proj0(a); return place(q.u, q.v); }; // map space → screen
  const f = (a) => g(warp(a)); // world → screen
  const ground = (a) => g({ ...warp(a), y: floorY });
  // The map camera's own axes, in world space: a free drag moves in the plane you are looking at.
  const right = { x: cy, y: 0, z: sy };
  const up = { x: sy * sp, y: cp, z: -cy * sp };
  const vec = (at, a) => { const s0 = f(at); const s1 = f(add(at, a, 50)); return { x: (s1.x - s0.x) / 50, y: (s1.y - s0.y) / 50 }; };
  // Pointer travel in map units → world travel, free or locked.
  const delta = (d, axis, at) => {
    if (axis === 'xz') {
      const sx = vec(at, AXES.x.v);
      const sz = vec(at, AXES.z.v);
      const det = sx.x * sz.y - sx.y * sz.x;
      if (Math.abs(det) < 1e-9) return { x: 0, y: 0, z: 0 };
      return { x: (d.x * sz.y - d.y * sz.x) / det, y: 0, z: (sx.x * d.y - sx.y * d.x) / det };
    }
    if (axis) {
      const a = AXES[axis].v;
      const s = vec(at, a);
      return add({ x: 0, y: 0, z: 0 }, a, (d.x * s.x + d.y * s.y) / Math.max(1e-9, s.x * s.x + s.y * s.y));
    }
    const s = vec(at, right);
    const k = Math.hypot(s.x, s.y) || 1;
    return add(add({ x: 0, y: 0, z: 0 }, right, d.x / k), up, -d.y / k);
  };
  return { f, g, ground, vec, delta, pw, ph, floorY, fx0, fx1, fz0, fz1, rad, corners, scale };
}

/** Hairlines: the map is for looking at the move. The lines stop short so a point's centre stays free for a plain drag. */
function Gizmo({ fr, at }) {
  const o = fr.f(at);
  const screen = Object.fromEntries(Object.keys(AXES).map((k) => [k, fr.vec(at, AXES[k].v)]));
  const longest = Math.max(...Object.values(screen).map((a) => Math.hypot(a.x, a.y)), 1e-9);
  const dirOf = (k) => { const a = screen[k]; const l = Math.hypot(a.x, a.y) || 1; return { x: a.x / l, y: a.y / l }; };
  const out = (d, r) => ({ x: o.x + d.x * r, y: o.y + d.y * r });
  const dx = dirOf('x');
  const dz = dirOf('z');
  const square = [[11, 11], [17, 11], [17, 17], [11, 17]].map(([a, b]) => `${(o.x + dx.x * a + dz.x * b).toFixed(1)},${(o.y + dx.y * a + dz.y * b).toFixed(1)}`).join(' ');
  return (
    <g className="ve-cam-map-gizmo">
      {Object.keys(AXES).map((key) => {
        if (Math.hypot(screen[key].x, screen[key].y) < longest * 0.18) return null; // pointing at the viewer
        const d = dirOf(key);
        const from = out(d, 8);
        const tip = out(d, 20);
        return (
          <g key={key} data-axis={key} className="ve-cam-map-axis">
            <title>{`Move along ${key.toUpperCase()}`}</title>
            <line x1={from.x} y1={from.y} x2={tip.x} y2={tip.y} stroke="transparent" strokeWidth="10" />
            <line x1={from.x} y1={from.y} x2={tip.x} y2={tip.y} stroke={AXES[key].color} strokeWidth="0.9" />
            <circle className="ve-cam-map-tip" cx={tip.x} cy={tip.y} r="1.5" fill={AXES[key].color} />
          </g>
        );
      })}
      {/* Last: it sits between the X and Z lines, whose wide hit areas would swallow it. */}
      <g data-axis="xz" className="ve-cam-map-axis">
        <title>Slide along the floor</title>
        <polygon points={square} fill="transparent" stroke="transparent" strokeWidth="7" />
        <polygon points={square} fill="none" stroke="#9fb0aa" strokeWidth="0.8" />
      </g>
    </g>
  );
}

// Kept between mounts: the panel mounts this per tab, and the map shouldn't swing back each time.
let rememberedOrbit = { yaw: -0.62, pitch: 0.36 };

export default function CameraMoveMap({
  item,
  frame,
  // The playhead within the clip, 0-100, or null while playing or outside the clip.
  playheadPct = null,
  // The evaluated pose where the item alone can't give it (Zoom's plan needs the project).
  pose = null,
  // The times of the keys this mode shows, 0-100.
  keyTimes = [],
  keyTolerancePct = 0.5,
  capture = false,
  // Whether the camera itself can be dragged here.
  cameraMovable = false,
  selection = [],
  onSelection,
  // (patch, coalesce) — onto the camera item.
  onWrite,
  onSeek,
  onRigPatch,
  hud = '',
  children,
}) {
  const mode = item?.cameraMoveMode || 'free';
  const width = Math.max(1, Number(frame?.width) || 1920);
  const height = Math.max(1, Number(frame?.height) || 1080);
  const size = useMemo(() => ({ width, height }), [width, height]);
  const [orbit, setOrbit] = useState(rememberedOrbit);
  const [frozen, setFrozen] = useState(null);
  // Null during playback: the map holds the last paused position rather than jumping to the clip's start.
  const [pct, setPct] = useState(Number.isFinite(playheadPct) ? playheadPct : 0);
  if (Number.isFinite(playheadPct) && playheadPct !== pct) setPct(playheadPct);

  const route = useMemo(() => {
    // (camlayer) from the rig's own +Y-down space (cameraRig.js rigToWorld)
    if (mode === 'rig') return sampleCameraRig(normalizeCameraRig(item?.cameraRig), 64).map(rigToWorld);
    if (mode === 'path') {
      const path = item?.cameraPath;
      if (!path || (path.points || []).length < 2) return [];
      const out = [];
      for (let i = 0; i <= 64; i += 1) {
        const hit = evaluateCameraPath(path, i / 64);
        if (hit) out.push(hit.position);
      }
      return out;
    }
    if (mode === 'free' && keyTimes.length > 1) {
      const a = keyTimes[0];
      const b = keyTimes[keyTimes.length - 1];
      return Array.from({ length: 65 }, (_, i) => toWorld(getCameraPose(item, (a + ((b - a) * i) / 64) / 100, size) || CAMERA_NEUTRAL, width, height));
    }
    return [];
  }, [mode, item, keyTimes, size, width, height]);
  const keys = useMemo(() => {
    if (mode === 'path') return (item?.cameraPath?.points || []).map((p, i) => ({ i, pos: p, pct: keyTimes[i] ?? 0 }));
    if (mode === 'free') return keyTimes.map((t, i) => ({ i, pct: t, pos: toWorld(getCameraPose(item, t / 100, size) || CAMERA_NEUTRAL, width, height) }));
    return [];
  }, [mode, item, keyTimes, size, width, height]);

  const now = pose || getCameraPose(item, pct / 100, size) || CAMERA_NEUTRAL;
  const cam = toWorld(now, width, height);
  const fwd = cameraForward(now);
  const fr = frozen || frame3D(cam, [...route, ...keys.map((k) => k.pos)], orbit, width, height);

  // Gestures live partly in window listeners, so the changing props are mirrored into a ref.
  const live = useRef({});
  useLayoutEffect(() => {
    live.current = { item, pct, keyTolerancePct, capture, onWrite, onRigPatch, size, fr, keys, keyTimes, pose: now, cam };
  });
  const svgRef = useRef(null);
  const mapPoint = (e) => {
    const r = svgRef.current.getBoundingClientRect();
    const k = MW / r.width;
    return { x: e.clientX * k, y: e.clientY * k };
  };

  const applyDrag = (m, d, ev, coalesce) => {
    const l = live.current;
    if (m.kind === 'path') {
      l.onWrite?.({ cameraPath: movePathPoints(l.item.cameraPath, m.base, m.indices, d) }, coalesce);
    } else if (m.kind === 'free') {
      const out = moveFreeKeys({ item: m.item, keys: m.keys, keyTimes: m.keyTimes, delta: d, frame: l.size, keyTolerancePct: l.keyTolerancePct });
      l.onWrite?.({ propertyKeyframes: out.propertyKeyframes }, coalesce);
    } else if (m.kind === 'tangent') {
      l.onWrite?.({ cameraPath: dragPathTangent(l.item.cameraPath, m.base, m.index, m.key, add(m.at, d), ev.altKey) }, coalesce);
    } else if (m.kind === 'rig') {
      // Against the live rig: the endpoint solver unwraps the sweep from it.
      l.onRigPatch?.(cameraRigFromEndpoint(normalizeCameraRig(l.item?.cameraRig), m.which, worldToRig(add(m.at, d))), coalesce);
    } else if (m.kind === 'camera') {
      const updates = cameraMoveUpdates(
        { item: l.item, pct: l.pct, keyTolerancePct: l.keyTolerancePct },
        m.gesture,
        { capture: l.capture, frame: l.size },
        propsForWorld(add(m.at, d), m.gesture.base, l.size),
      );
      if (updates) l.onWrite?.(updates, coalesce);
    }
  };

  const beginDrag = (e, spec) => {
    e.preventDefault();
    const held = live.current.fr;
    const start = mapPoint(e);
    const m = { ...spec };
    let moved = false;
    setFrozen(held);
    const move = (ev) => {
      const at = mapPoint(ev);
      const d = { x: at.x - start.x, y: at.y - start.y };
      if (!moved && Math.hypot(d.x, d.y) < 1.5) return;
      applyDrag(m, held.delta(d, m.axis, m.at), ev, moved);
      moved = true;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      setFrozen(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  const selectionDrag = (sel, axis) => {
    const l = live.current;
    const picked = sel.map((i) => l.keys[i]).filter(Boolean);
    const at = centroid(picked.map((k) => k.pos));
    if (mode === 'path') {
      return { kind: 'path', axis, at, base: l.item.cameraPath.points.map((p) => ({ ...p })), indices: picked.map((k) => k.i) };
    }
    return {
      kind: 'free',
      axis,
      at,
      item: l.item,
      keyTimes: l.keyTimes,
      keys: picked.map((k) => ({ pct: k.pct, pose: getCameraPose(l.item, k.pct / 100, l.size) || CAMERA_NEUTRAL, world: k.pos })),
    };
  };
  const cameraDrag = (axis) => {
    const l = live.current;
    return { kind: 'camera', axis, at: l.cam, gesture: { base: l.pose, item: l.item } };
  };

  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    const hit = (s) => e.target.closest?.(s);
    const axis = hit('[data-axis]');
    if (axis) {
      beginDrag(e, selection.length ? selectionDrag(selection, axis.dataset.axis) : cameraDrag(axis.dataset.axis));
      return;
    }
    const tangent = hit('[data-tangent]');
    if (tangent) {
      const index = selection[0];
      const pt = item.cameraPath.points[index];
      beginDrag(e, { kind: 'tangent', axis: null, index, key: tangent.dataset.tangent, at: add(pt, pt[tangent.dataset.tangent]), base: item.cameraPath.points.map((p) => ({ ...p })) });
      return;
    }
    const point = hit('[data-point]');
    if (point) {
      const i = Number(point.dataset.point);
      if (e.shiftKey || e.metaKey || e.ctrlKey) {
        onSelection?.(selection.includes(i) ? selection.filter((x) => x !== i) : [...selection, i]);
        return;
      }
      const next = selection.includes(i) ? selection : [i];
      onSelection?.(next);
      beginDrag(e, selectionDrag(next, null));
      onSeek?.(keyTimes[i]);
      return;
    }
    const rig = hit('[data-rig]');
    if (rig) {
      const which = rig.dataset.rig;
      beginDrag(e, { kind: 'rig', axis: null, which, at: which === 'end' ? route[route.length - 1] : route[0] });
      return;
    }
    if (hit('[data-campoint]')) { beginDrag(e, cameraDrag(null)); return; }
    // Empty space turns the map; a click that never turned it clears the selection.
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY, ...rememberedOrbit };
    let turned = false;
    const move = (ev) => {
      if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 2) turned = true;
      rememberedOrbit = {
        yaw: start.yaw + (ev.clientX - start.x) * 0.012,
        pitch: clamp(start.pitch + (ev.clientY - start.y) * 0.008, -0.2, 1.3),
      };
      setOrbit(rememberedOrbit);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (!turned && selection.length) onSelection?.([]);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  const { f, g, pw, ph, floorY } = fr;
  const lineAttrs = (a, b) => ({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
  // The camera: a small frustum, turned where it really looks and narrowing as the lens zooms in.
  const norm = (a) => { const l = Math.hypot(a.x, a.y, a.z) || 1; return { x: a.x / l, y: a.y / l, z: a.z / l }; };
  const right = norm({ x: -fwd.z, y: 0, z: fwd.x });
  const up = norm({ x: right.y * fwd.z - right.z * fwd.y, y: right.z * fwd.x - right.x * fwd.z, z: right.x * fwd.y - right.y * fwd.x });
  const L = (fr.rad * 0.2) / fr.scale;
  const base = add(cam, fwd, L);
  const hw = (L * 0.42) / Math.max(0.5, Number(now.camZoom) || 1);
  const hh = hw * (height / width);
  const corner = (a, b) => add(add(base, right, a * hw), up, b * hh);
  const view = [corner(-1, 1), corner(1, 1), corner(1, -1), corner(-1, -1)];
  const camAt = f(cam);
  const picked = selection.map((i) => keys[i]?.pos).filter(Boolean);
  const lonePoint = mode === 'path' && selection.length === 1 ? item?.cameraPath?.points?.[selection[0]] : null;
  const lines = [1, 2, 3, 4, 5];

  return (
    <div className="ve-scene-map ve-scene-move-map ve-cam-map">
      <svg ref={svgRef} viewBox={`0 0 ${MW} ${MH}`} onPointerDown={onPointerDown} role="img" aria-label="Camera move">
        <path d={`${poly(fr.corners, g)} Z`} fill="#14181a" stroke="#22282b" />
        {lines.map((i) => {
          const u = fr.fx0 + ((fr.fx1 - fr.fx0) * i) / 6;
          const w = fr.fz0 + ((fr.fz1 - fr.fz0) * i) / 6;
          return (
            <g key={i} stroke="#1e2326">
              <line {...lineAttrs(g({ x: u, y: floorY, z: fr.fz0 }), g({ x: u, y: floorY, z: fr.fz1 }))} />
              <line {...lineAttrs(g({ x: fr.fx0, y: floorY, z: w }), g({ x: fr.fx1, y: floorY, z: w }))} />
            </g>
          );
        })}
        <path data-plate="1" d={`${poly([{ x: -pw, y: ph, z: 0 }, { x: pw, y: ph, z: 0 }, { x: pw, y: -ph, z: 0 }, { x: -pw, y: -ph, z: 0 }], g)} Z`} fill="#22282c" stroke="#3a4145" />
        <path data-subject="1" d={`${poly([{ x: -pw * 0.14, y: ph * 0.34, z: 0 }, { x: pw * 0.14, y: ph * 0.34, z: 0 }, { x: pw * 0.14, y: -ph * 0.34, z: 0 }, { x: -pw * 0.14, y: -ph * 0.34, z: 0 }], g)} Z`} fill="#e8ebea" />
        {route.length > 1 && <path d={poly(route, fr.ground)} fill="none" stroke={GREEN} strokeOpacity="0.22" strokeWidth="1.4" />}
        {keys.map((k) => <line key={k.i} {...lineAttrs(f(k.pos), fr.ground(k.pos))} stroke="#9fb0aa" strokeOpacity="0.3" strokeDasharray="2 3" />)}
        {route.length > 1 && <path data-route="1" d={poly(route, f)} fill="none" stroke={GREEN} strokeOpacity="0.85" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />}

        <path d={`${poly(view, f)} Z`} fill="#eef2f0" fillOpacity="0.16" stroke="#eef2f0" strokeOpacity="0.55" pointerEvents="none" />
        {view.map((b, i) => <line key={i} {...lineAttrs(camAt, f(b))} stroke="#eef2f0" strokeOpacity="0.55" pointerEvents="none" />)}

        {mode === 'rig' && route.length > 1 && onRigPatch && (() => {
          const a = f(route[0]);
          const b = f(route[route.length - 1]);
          return (
            <>
              <g data-rig="end" className="ve-scene-map-handle">
                <title>Drag the end of the move</title>
                <circle cx={b.x} cy={b.y} r="12" fill="transparent" />
                <circle cx={b.x} cy={b.y} r="5.5" fill="#151718" stroke={GREEN} strokeWidth="1.6" />
              </g>
              <g data-rig="start" className="ve-scene-map-handle">
                <title>Drag the start of the move</title>
                <circle cx={a.x} cy={a.y} r="12" fill="transparent" />
                <circle cx={a.x} cy={a.y} r="5.5" fill={GREEN} stroke="#151718" strokeWidth="1.4" />
              </g>
            </>
          );
        })()}

        {keys.map((k, i) => {
          const at = f(k.pos);
          const selected = selection.includes(i);
          const here = Math.abs(k.pct - pct) <= keyTolerancePct;
          const size2 = selected ? 9 : 7;
          return (
            <g key={k.i} data-point={i} className="ve-scene-map-handle">
              <title>{`Key ${i + 1}: drag to move it, Shift adds to the selection`}</title>
              <circle cx={at.x} cy={at.y} r="11" fill="transparent" />
              <rect
                x={at.x - size2 / 2} y={at.y - size2 / 2} width={size2} height={size2} rx={selected ? 2 : 1.5}
                fill={selected ? '#eef2f0' : here ? TEAL : '#151718'}
                stroke={selected || here ? '#151718' : '#9fb0aa'} strokeWidth="1.3"
              />
            </g>
          );
        })}

        {cameraMovable ? (
          <g data-campoint="1" className="ve-scene-map-handle">
            <title>Drag the camera</title>
            <circle cx={camAt.x} cy={camAt.y} r="10" fill="transparent" />
            <circle cx={camAt.x} cy={camAt.y} r="4" fill="#eef2f0" stroke="#151718" />
          </g>
        ) : <circle cx={camAt.x} cy={camAt.y} r="4" fill="#eef2f0" stroke="#151718" pointerEvents="none" />}

        {picked.length > 0 && <Gizmo fr={fr} at={centroid(picked)} />}
        {!picked.length && cameraMovable && <Gizmo fr={fr} at={cam} />}

        {/* Tangents last, or the gizmo over them could never be grabbed. A lone point only, as in the 3D view. */}
        {lonePoint && ['hIn', 'hOut'].map((key) => {
          if (!lonePoint[key]) return null;
          const tip = add(lonePoint, lonePoint[key]);
          const t = f(tip);
          return (
            <g key={key}>
              <line {...lineAttrs(f(lonePoint), t)} stroke={CYAN} strokeOpacity="0.55" pointerEvents="none" />
              <g data-tangent={key} className="ve-scene-map-handle">
                <title>Bend the curve. Alt breaks the pair</title>
                <circle cx={t.x} cy={t.y} r="5" fill="transparent" />
                <circle cx={t.x} cy={t.y} r="2.4" fill={CYAN} />
              </g>
            </g>
          );
        })}
      </svg>
      <div className="ve-scene-map-hud">{hud}</div>
      {children}
    </div>
  );
}
