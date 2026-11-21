#!/usr/bin/env python3
"""glpath.py — lines with corners drawn as a designer draws them, and a check for the ones that are not.

A connector between cards, a route, a bracket or a flow-chart link is STRAIGHT LEGS joined by arcs of ONE radius.
The smooth tangent rule `(P[next] - P[prev]) / 6` (Catmull-Rom, the editor's auto-smooth) is for a free curve through
points: at a sharp turn it overshoots past the corner and curls back (a hook), worse when the legs differ in length or
the shape's box scales x and y differently (shapePath points are box fractions per axis). And two measured points a
few px apart make a long leg that should be vertical lean visibly.

  glpath.py corner --points "x,y x,y x,y" [--radius 20] [--snap 4] [--frame 1920x1080]
      the item fields of a GLEA `line` shape (shapeType, px box, shapePath, panX/panY) for those composition px
      (from the frame centre, y down): straight legs, legs within --snap degrees of vertical/horizontal made exact,
      every turn rounded with --radius px (a short leg gets a smaller radius, never an overlap). Merge the fields into
      the item and add the stroke (shapeFillColor, lineWidth, lineDash…).
  glpath.py check PROJECT.json
      every shape path, line and motion path (top level and inside sequences): HOOK (the curve turns far more than its
      anchors do) and LEAN (a straight leg 0.3-4 degrees off vertical or horizontal). Exit 1 when there is one.

As a module: fields = glpath.corner_path(points_px, radius); issues = glpath.paths_check(data);
glpath.path_issues(points, closed, px_per_unit_x, px_per_unit_y).
"""
import argparse, json, math, sys

import numpy as np


# ── building ──────────────────────────────────────────────────────────────────────────────────────────────────────
def corner_path(points, radius=20.0, snap_deg=4.0, frame=(1920, 1080)):
    """GLEA `line` item fields through `points` (composition px from the frame centre, y down): straight legs, legs
    within snap_deg of vertical or horizontal made exact, every turn rounded with ONE radius in px."""
    P = [np.array(p, float) for p in points]
    for i in range(1, len(P)):                          # snap the legs the eye reads as vertical / horizontal
        d = P[i] - P[i - 1]
        if np.hypot(*d) < 1e-6: continue
        ang = math.degrees(math.atan2(abs(d[1]), abs(d[0])))
        if ang < snap_deg: P[i][1] = P[i - 1][1]
        elif ang > 90 - snap_deg: P[i][0] = P[i - 1][0]
    Q = [P[0]]
    for p in P[1:]:                                     # drop repeats and points on a straight run
        if np.hypot(*(p - Q[-1])) < 1e-6: continue
        if len(Q) >= 2:
            a, b = Q[-1] - Q[-2], p - Q[-1]
            if abs(a[0] * b[1] - a[1] * b[0]) < 1e-6 * np.hypot(*a) * np.hypot(*b) and a @ b > 0: Q[-1] = p; continue
        Q.append(p)
    if len(Q) < 2: raise ValueError('corner_path: needs two distinct points')
    anchors = [{'p': Q[0], 'hin': np.zeros(2), 'hout': np.zeros(2)}]
    for i in range(1, len(Q) - 1):
        u = Q[i - 1] - Q[i]; v = Q[i + 1] - Q[i]; lu, lv = np.hypot(*u), np.hypot(*v); u, v = u / lu, v / lv
        phi = math.acos(float(np.clip(u @ v, -1, 1)))   # the angle between the legs
        if phi > math.pi - 1e-3:
            anchors.append({'p': Q[i], 'hin': np.zeros(2), 'hout': np.zeros(2)}); continue
        t = math.tan(phi / 2); d = min(radius / t, 0.5 * lu, 0.5 * lv); r = d * t
        k = 4.0 / 3.0 * math.tan((math.pi - phi) / 4.0) * r          # a circular arc's handle (0.5523 r at 90 deg)
        anchors.append({'p': Q[i] + u * d, 'hin': np.zeros(2), 'hout': -u * k})
        anchors.append({'p': Q[i] + v * d, 'hin': -v * k, 'hout': np.zeros(2)})
    anchors.append({'p': Q[-1], 'hin': np.zeros(2), 'hout': np.zeros(2)})
    for a, b in zip(anchors[:-1], anchors[1:]):         # straight legs: handles along the leg (smooth anchors, straight legs)
        if not b['hin'].any() and not a['hout'].any():
            d = (b['p'] - a['p']) / 3.0; a['hout'] = d; b['hin'] = -d
    pts = np.array([a['p'] for a in anchors]); lo, hi = pts.min(0), pts.max(0); c = (lo + hi) / 2; sz = np.maximum(hi - lo, 1.0)
    f = lambda v: {'x': round(float(v[0] / sz[0]), 5), 'y': round(float(v[1] / sz[1]), 5)}
    path = {'points': [dict(f(a['p'] - c), hIn=f(a['hin']), hOut=f(a['hout']), manual=True) for a in anchors], 'closed': False}
    return dict(shapeType='line', shapeSizeUnit='px', shapeWidthPx=round(float(sz[0]), 3), shapeHeightPx=round(float(sz[1]), 3),
                shapePath=path, lineCap='round', lineJoin='round',
                panX=round(float(c[0]) / frame[0] * 100, 4), panY=round(float(c[1]) / frame[1] * 100, 4))


# ── checking ──────────────────────────────────────────────────────────────────────────────────────────────────────
def _bez_pts(A, B, sx, sy, n=48):
    p0 = np.array([A['x'] * sx, A['y'] * sy]); h0 = A.get('hOut') or {}; h3 = B.get('hIn') or {}
    p1 = p0 + [h0.get('x', 0) * sx, h0.get('y', 0) * sy]; p3 = np.array([B['x'] * sx, B['y'] * sy])
    p2 = p3 + [h3.get('x', 0) * sx, h3.get('y', 0) * sy]
    t = np.linspace(0, 1, n)[:, None]
    return (1 - t) ** 3 * p0 + 3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t * t * p2 + t ** 3 * p3


def _turning(C):
    d = np.diff(C, axis=0); d = d[np.linalg.norm(d, axis=1) > 1e-6]
    if len(d) < 2: return 0.0
    a = np.unwrap(np.arctan2(d[:, 1], d[:, 0])); return float(np.degrees(np.abs(np.diff(a)).sum()))


def path_issues(points, closed, sx, sy):
    """HOOK / LEAN on one bezier path; sx, sy: px per path unit on each axis (a shapePath: the box's width and height;
    a motionPath: 1, 1)."""
    P = [p for p in points if isinstance(p, dict) and 'x' in p and 'y' in p]
    if len(P) < 2: return []
    pairs = list(zip(P[:-1], P[1:])) + ([(P[-1], P[0])] if closed else [])
    out = []
    if not closed:
        C = np.vstack([_bez_pts(a, b, sx, sy) for a, b in pairs])
        A = np.array([[p['x'] * sx, p['y'] * sy] for p in P])
        ct, pt = _turning(C), _turning(A)
        if ct - pt > max(35.0, 0.6 * pt):
            out.append('HOOK: the curve turns %.0f deg where its anchors turn %.0f: a smooth tangent through a sharp turn '
                       'overshoots and curls back. Straight legs and one corner radius (glpath.corner_path)' % (ct, pt))
    for k, (a, b) in enumerate(pairs):
        d = np.array([(b['x'] - a['x']) * sx, (b['y'] - a['y']) * sy]); L = float(np.linalg.norm(d))
        if L < 60: continue
        seg = _bez_pts(a, b, sx, sy); nrm = np.array([-d[1], d[0]]) / L
        if np.abs((seg - seg[0]) @ nrm).max() > max(2.0, 0.012 * L): continue     # a curve, not a straight leg
        ang = math.degrees(math.atan2(abs(d[1]), abs(d[0])))                     # 0 = horizontal, 90 = vertical
        off = min(ang, 90 - ang)
        if 0.3 < off < 4.0:
            out.append('LEAN: leg %d (%.0f px) is %.1f deg off %s, a %.0f px drift: snap its anchors to one %s'
                       % (k, L, off, 'horizontal' if ang < 45 else 'vertical', L * math.sin(math.radians(off)), 'y' if ang < 45 else 'x'))
    return out


def paths_check(data):
    """every HOOK / LEAN in a project's data (top level and inside sequences)."""
    W = float((data.get('videoSize') or {}).get('w') or 1920); H = float((data.get('videoSize') or {}).get('h') or 1080)
    out = []

    def walk(d, seq=''):
        for ch in d.get('channels', []):
            for it in ch.get('items', []):
                sp = it.get('shapePath')
                if isinstance(sp, dict) and it.get('shapeType') in ('path', 'line'):
                    if it.get('shapeSizeUnit') == 'px':
                        sx, sy = float(it.get('shapeWidthPx') or 1), float(it.get('shapeHeightPx') or 1)
                    else:
                        sx, sy = W * float(it.get('shapeWidthPct') or 40) / 100, H * float(it.get('shapeHeightPct') or 40) / 100
                    closed = bool(sp.get('closed')) and it.get('shapeType') != 'line'
                    for m in path_issues(sp.get('points') or [], closed, sx, sy):
                        out.append({'sequence': seq, 'item': it.get('id'), 'name': it.get('customName') or '', 'what': 'shapePath', 'issue': m})
                mp = it.get('motionPath')
                if isinstance(mp, dict) and mp.get('points'):
                    for m in path_issues(mp['points'], bool(mp.get('closed')), 1.0, 1.0):
                        out.append({'sequence': seq, 'item': it.get('id'), 'name': it.get('customName') or '', 'what': 'motionPath', 'issue': m})
        for c in d.get('clips', []):
            if isinstance(c.get('sequence'), dict): walk(c['sequence'], c.get('id') or '?')
    walk(data)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    c = sub.add_parser('corner'); c.add_argument('--points', required=True); c.add_argument('--radius', type=float, default=20.0)
    c.add_argument('--snap', type=float, default=4.0); c.add_argument('--frame', default='1920x1080')
    k = sub.add_parser('check'); k.add_argument('project')
    a = ap.parse_args()
    if a.cmd == 'corner':
        pts = [tuple(float(v) for v in p.split(',')) for p in a.points.split()]
        fw, fh = (float(v) for v in a.frame.lower().split('x'))
        print(json.dumps(corner_path(pts, a.radius, a.snap, (fw, fh)), indent=1))
        return
    j = json.load(open(a.project)); data = j['data'] if isinstance(j.get('data'), dict) else j
    res = paths_check(data)
    for r in res: print('  %s%s "%s" %s: %s' % (r['sequence'] + '/' if r['sequence'] else '', r['item'], r['name'], r['what'], r['issue']))
    print('%d path issues' % len(res))
    sys.exit(1 if res else 0)


if __name__ == '__main__':
    main()
