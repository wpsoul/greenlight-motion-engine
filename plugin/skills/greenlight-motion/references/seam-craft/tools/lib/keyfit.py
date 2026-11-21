#!/usr/bin/env python3
"""keyfit.py — motion as the FEWEST eased keys. Fits a dense curve (a measured track, a solved pan, a log zoom, any
value you computed per frame) to C1 Custom-bezier keys within a tolerance, and finds and thins the tracks of a Video
Editor project that were keyed frame by frame.

A move is its keys and their easing: a slide from left to right is 2 keys with one bezier, a move with a bounce or a
change of direction 4–6. A key on every frame renders the same and can't be edited: the Keyframes panel shows a wall
of diamonds and nobody can change the move's timing or its ease. So compute the motion as densely as you like, then
fit it, and write the fitted keys.

  keyfit.py curve CURVE.json --tol T [--rel] [--max-keys 10] [--no-refine] [--item-f0 F --item-frames N] --out K.json
      CURVE.json: [[frame, value], …] or {"frames": […], "values": […]} (film frames, one per frame or finer).
      --tol: the largest miss you accept, in the value's units (px, degrees, opacity 0–1). --rel: T is a fraction of
      the value instead (scale and zoom: 0.003 = 0.3 %, the same look at ×1 and at ×20).
      --item-f0 / --item-frames: the item's first film frame and its played length in frames; then the output also
      has `propertyKeyframes` (position = % of the item, value as a string, `Custom` + `bezier`).
  keyfit.py moves TRACKS.json --noise N [--item-f0 F --item-frames N] --out K.json
      MEASURED tracks of one layer -> moves: smoothed at the measurement's noise, split where the motion stops,
      turns or slows and speeds up again, 2 keys + one ease per move, shared key frames, each move's start and end
      speeds the measured ones (so the speed carries through every key the motion doesn't stop at). Use it for every track you
      measured (a tracker, hand-read seeds); `curve` only for exact computed curves.
  keyfit.py check PROJECT.json [--min-keys 8] [--fps 30] [--easings CAPS.json] [--strict]
      every numeric track (top level and inside sequences) that has ≥ --min-keys keys and could be written with half
      the keys or fewer within its tolerance. Exit 1 when there is one. PROJECT.json: a project GET ({data, version})
      or its `data`. It also lists, on tracks of any length, every inner key where a move that goes on the same way
      STOPs (eases to 0 and starts again) or JOLTs (its speed jumps): on screen a step. --strict fails on those too
      (--allow-stops ITEM,… for stops the reference itself makes) and on MANY: 8+ keys under 0.4 s apart (keys on
      a measurement's noise); 8+ keys far apart are LONG (a camera through several real moves) and pass.
      OVER: a Custom curve that goes past its next key and comes back (an elastic look); STALL: one whose handles are
      out of order (y1 > y2: a rise, a stall, a rise): --strict fails on both
      (--allow-over ITEM,… for a deliberate pop).
  keyfit.py thin PROJECT.json --out NEW.json [--items id,id] [--tracks translateX,scale] [--min-keys 8] [--easings …]
      refits those tracks and writes the project with the fewer keys (a copy for a look; write the live project
      with your own patch: keyfit.thin_item(item) inside the change function).
  Tracks left as they are: Hold steps (a clock, a flicker), tracks with an expression (`propertyKeyframeFx`: bounce
  and elastic reshape every segment), split slices (`easeSlice`), colours and paths, named easings without --easings
  (pass the capabilities: the shipped snapshot lib/editor_easings.json, a fresh `easing.py fetch caps.json`, or any
  saved GET /api/video-editor/capabilities with easings.keyframe.curves).

As a module: keys, err = keyfit.fit(frames, values, tol, rel=False); keyfit.to_glea(keys, f0, n_frames);
keyfit.dense_tracks(data); keyfit.thin_item(item). Keys are [(time, value, bezier_or_None)], the bezier on the key that
STARTS its segment (None on the last key).
"""
import argparse, copy, json, sys

import numpy as np

# The miss a viewer can't see at 1080p, per track: (tolerance, relative). Translate tracks are px, xPercent/yPercent
# % of the frame, rotations degrees, opacity 0–1, scale a multiplier (relative), corner pins % of the layer box.
TOL = {
    'translateX': (1.0, False), 'translateY': (1.0, False), 'translateZ': (2.0, False),
    'xPercent': (0.08, False), 'yPercent': (0.08, False),
    'motionPathOffsetX': (1.0, False), 'motionPathOffsetY': (1.0, False), 'motionPathOffsetZ': (2.0, False),
    'motionPathT': (0.05, False), 'camPathT': (0.05, False),         # % of the path: 1 px on a 2000 px path
    'rotate': (0.2, False), 'rotateX': (0.2, False), 'rotateY': (0.2, False),
    'scale': (0.003, True), 'scaleX': (0.003, True), 'scaleY': (0.003, True),
    'opacity': (0.01, False), 'blur': (0.25, False),
    'camZoom': (0.003, True), 'camX': (1.0, False), 'camY': (1.0, False), 'camRoll': (0.2, False),
    'camDolly': (2.0, False), 'camTiltX': (0.2, False), 'camTiltY': (0.2, False),
}
CORNER_PIN = ('cpULX', 'cpULY', 'cpURX', 'cpURY', 'cpLRX', 'cpLRY', 'cpLLX', 'cpLLY')
RANGE_SHARE = 0.005        # any other numeric track: 0.5 % of the range it moves through


def tolerance(track, values):
    if track in TOL: return TOL[track]
    if track in CORNER_PIN: return 0.08, False
    span = float(np.ptp(values)) if len(values) else 0.0
    return max(span * RANGE_SHARE, 1e-6), False


# ── the curve ─────────────────────────────────────────────────────────────────────────────────────────────────────
def bez_ease(u, x1, y1, x2, y2):
    u = np.clip(np.asarray(u, float), 0, 1); lo = np.zeros_like(u); hi = np.ones_like(u); s = u.copy()
    bx = lambda s: 3 * x1 * s * (1 - s) ** 2 + 3 * x2 * s * s * (1 - s) + s ** 3
    for _ in range(40):
        cx = bx(s); lo = np.where(cx < u, s, lo); hi = np.where(cx >= u, s, hi); s = (lo + hi) / 2
    return 3 * y1 * s * (1 - s) ** 2 + 3 * y2 * s * s * (1 - s) + s ** 3


def evaluate(t, keys):
    t = np.asarray(t, float); out = np.empty_like(t)
    out[t <= keys[0][0]] = keys[0][1]; out[t >= keys[-1][0]] = keys[-1][1]
    for (ta, va, bz), (tb, vb, _) in zip(keys[:-1], keys[1:]):
        m = (t >= ta) & (t < tb)
        if m.any(): out[m] = va + (vb - va) * bez_ease((t[m] - ta) / (tb - ta), *bz)
    return out


def y_range(ts, vs, a, b):
    """the range a segment's bezier y handles may take between samples a and b. Where the samples stay between the
    two key values, the fitted curve must too: 0…1 (a bezier never leaves the hull of its handles). A free handle
    there buys a little accuracy with a value the motion never had: a scale fitted from rest dips under ×1 for a
    frame (an open frame edge), an opacity goes below 0. Only a curve that really overshoots gets −3…4."""
    lo, hi = sorted((float(vs[a]), float(vs[b]))); eps = 1e-9 * max(1.0, hi - lo)
    seg = vs[a:b + 1]
    return (0.0, 1.0) if seg.min() >= lo - eps and seg.max() <= hi + eps else (-3.0, 4.0)


def hermite_keys(ts, vs, idx):
    slope = np.gradient(vs, ts); keys = []
    for a, b in zip(idx[:-1], idx[1:]):
        dt, dv = ts[b] - ts[a], vs[b] - vs[a]; lo, hi = y_range(ts, vs, a, b)
        bz = (1 / 3, 0.0, 2 / 3, 1.0) if abs(dv) < 1e-9 else (1 / 3, float(np.clip(slope[a] * dt / (3 * dv), lo, hi)), 2 / 3, float(np.clip(1 - slope[b] * dt / (3 * dv), lo, hi)))
        keys.append((float(ts[a]), float(vs[a]), bz))
    keys.append((float(ts[idx[-1]]), float(vs[idx[-1]]), None)); return keys


def _miss(ts, vs, keys, rel):
    e = np.abs(evaluate(ts, keys) - vs)
    return e / np.maximum(np.abs(vs), 1e-6) if rel else e


def refine(ts, vs, keys, iters=3000, rel=False):
    """Least-squares on every segment's handles (x in 0..1, y in y_range: 0..1 unless the samples overshoot), keys
    stay where they are, with a soft constraint that the speed is continuous through each interior key. Starts from
    the Hermite handles."""
    from scipy.optimize import least_squares
    kt = [k[0] for k in keys]; kv = [k[1] for k in keys]; n = len(keys) - 1
    span = max(float(np.ptp(vs)), 1e-6)
    w = 1 / np.maximum(np.abs(vs), 1e-6) if rel else 1 / span
    def unpack(p): return [(kt[i], kv[i], tuple(p[4 * i:4 * i + 4])) for i in range(n)] + [(kt[-1], kv[-1], None)]
    def resid(p):
        ks = unpack(p); r = (evaluate(ts, ks) - vs) * w; c = []
        for i in range(1, n):
            a, b = p[4 * (i - 1):4 * i], p[4 * i:4 * i + 4]
            d0 = (kv[i] - kv[i - 1]) / (kt[i] - kt[i - 1]); d1 = (kv[i + 1] - kv[i]) / (kt[i + 1] - kt[i])
            vin = d0 * (1 - a[3]) / max(1 - a[2], 0.02); vout = d1 * b[1] / max(b[0], 0.02)
            c.append(np.clip((vin - vout) / span * (kt[i + 1] - kt[i - 1]) / 2, -50, 50))
        return np.concatenate([r, c]) if c else r
    p0 = np.array(sum([list(k[2]) for k in keys[:-1]], []), float)
    at = [int(np.argmin(np.abs(ts - t))) for t in kt]
    yr = [y_range(ts, vs, at[i], at[i + 1]) for i in range(n)]
    lb = np.array(sum([[0, lo, 0, lo] for lo, _ in yr], []), float); ub = np.array(sum([[1, hi, 1, hi] for _, hi in yr], []), float)
    sol = least_squares(resid, np.clip(p0, lb + 1e-6, ub - 1e-6), bounds=(lb, ub), max_nfev=iters)
    return unpack(sol.x)


def greedy(ts, vs, tol, max_keys, rel=False):
    """Add keys where the curve misses the samples most until every SAMPLE is within tol (or max_keys)."""
    idx = [0, len(ts) - 1]
    while True:
        keys = hermite_keys(ts, vs, idx)
        if len(idx) <= 8:
            try: keys = refine(ts, vs, keys, rel=rel)
            except Exception: pass
        err = _miss(ts, vs, keys, rel); mx = float(err.max())
        if mx <= tol or len(idx) >= max_keys: return keys, mx
        cand = [i for i in range(1, len(ts) - 1) if i not in idx and all(abs(i - j) > 1 for j in idx)] or [i for i in range(1, len(ts) - 1) if i not in idx]
        if not cand: return keys, mx
        idx = sorted(idx + [max(cand, key=lambda i: err[i])])


def fit(frames, values, tol, rel=False, max_keys=10, refine_handles=True):
    """The fewest C1 keys within tol of a dense curve. refine_handles=False keeps the Hermite handles: same tolerance,
    a few more keys, milliseconds instead of seconds on a long curve. Returns (keys, max_err)."""
    ts = np.asarray(frames, float); vs = np.asarray(values, float)
    order = np.argsort(ts); ts, vs = ts[order], vs[order]
    if len(ts) < 2: raise ValueError('fewer than 2 samples')
    if float(np.ptp(vs)) < 1e-9: return [(float(ts[0]), float(vs[0]), None)], 0.0      # no move: one key holds it
    if refine_handles: return greedy(ts, vs, tol, max_keys, rel)
    idx = [0, len(ts) - 1]
    while True:
        keys = hermite_keys(ts, vs, idx); err = _miss(ts, vs, keys, rel); mx = float(err.max())
        cand = [i for i in range(1, len(ts) - 1) if i not in idx]
        if mx <= tol or len(idx) >= max_keys or not cand: return keys, mx
        idx = sorted(idx + [max(cand, key=lambda i: err[i])])



# ---------------------------------------------------------------------------------------------------------------
# Measured motion: MOVES, not samples.
# A measured track carries the tracker's own scatter (±1–5 px; hand-read seeds ±30 px). `fit` above adds a key
# wherever a SAMPLE misses by more than the tolerance and takes its handles from the samples' slopes, so on a
# measured track it keys the noise: the keys sit on wiggles and the speed wobbles between them — drag, jiggle and
# stepping on screen although every key is "within tolerance" (owner, 2026-11-16: "all items are step movement").
# `moves` is for every measured track: it smooths the measurement at its noise level, splits it where the motion
# stops, turns back or slows and speeds up again, and writes each move as 2 keys with ONE least-squares ease (a third
# key at the speed peak only when a single ease misses by more than the visible limit). The tracks of one layer that
# cover the same span share their key frames, so x, y and scale move as one. Use `fit` only for exact computed
# curves (a solved pan, a log zoom), never for a track.
# ---------------------------------------------------------------------------------------------------------------
from scipy.ndimage import gaussian_filter1d  # noqa: E402
from scipy.optimize import least_squares as _lsq  # noqa: E402


def _dense(frames, values, rel, noise):
    """samples (sparse hand seeds or a per-frame track) -> a smooth per-frame curve over [f0, f1]."""
    f = np.asarray(frames, float); v = np.asarray(values, float)
    o = np.argsort(f); f, v = f[o], v[o]
    keep = np.concatenate([[True], np.diff(f) > 0]); f, v = f[keep], v[keep]
    if rel:
        v = np.log(np.maximum(v, 1e-6))
    grid = np.arange(int(round(f[0])), int(round(f[-1])) + 1, dtype=float)
    if len(f) < 4:
        d = np.interp(grid, f, v)
    elif len(f) > 0.6 * len(grid):
        # a per-frame track: a Gaussian about the size of the tracker's own steps
        d = gaussian_filter1d(np.interp(grid, f, v), max(2.0, (noise if not rel else 0.0) / 1.5), mode='nearest')
    else:
        # sparse seeds (hand-read or keyed): monotone between samples, so a hold never dips or overshoots,
        # then a light Gaussian; the move fit below draws the ease, so seed scatter can't become wobble
        from scipy.interpolate import PchipInterpolator
        d = gaussian_filter1d(PchipInterpolator(f, v)(grid), 3.0, mode='nearest')
    return grid, d


def _breaks(grid, curves, min_len=8, stop_share=0.12):
    """key frames: the ends, plus every frame where the joint motion nearly stops (a local speed minimum under
    stop_share of the neighbouring peaks) or any track turns back."""
    sp = np.zeros(len(grid))
    turns = set()
    for d in curves:
        v = np.gradient(d)
        rng = max(float(np.ptp(d)), 1e-9)
        sp += np.abs(v) / rng
        s = np.sign(np.where(np.abs(v) < 1e-4 * rng, 0, v))
        for i in range(1, len(s)):
            if s[i] != 0 and s[i - 1] != 0 and s[i] != s[i - 1] and float(np.ptp(d)) > 0:
                # a real turn: the track travels at least 4 % of its range on both sides
                a = d[max(0, i - 12):i]; b = d[i:i + 12]
                if len(a) and len(b) and min(np.ptp(a), np.ptp(b)) > 0.04 * rng:
                    turns.add(i)
    sp = gaussian_filter1d(sp, 1.0)
    br = {0, len(grid) - 1} | turns
    # a HOLD (no motion for min_len frames or more) is its own segment: its ends are keys. Without it a move that
    # starts after a hold eases over the hold as well (2026-11-16: a pull-back that starts at f1280 began shrinking at
    # f1200, exposing the bare background)
    still = sp < 0.02 * (sp.max() or 1.0)
    i = 0
    while i < len(still):
        if still[i]:
            j = i
            while j + 1 < len(still) and still[j + 1]: j += 1
            if j - i + 1 >= min_len:
                if i > 0: br.add(i)
                if j < len(still) - 1: br.add(j)
            i = j + 1
        else:
            i += 1
    for i in range(1, len(sp) - 1):
        if sp[i] <= sp[i - 1] and sp[i] <= sp[i + 1]:
            lp = sp[:i].max() if i > 0 else 0
            rp = sp[i + 1:].max() if i + 1 < len(sp) else 0
            if sp[i] < stop_share * min(lp, rp):
                br.add(i)
    br = sorted(br)
    out = [br[0]]
    for b in br[1:]:
        if b - out[-1] >= min_len:
            out.append(b)
        elif b == br[-1]:
            out[-1] = b
    if out[0] != 0:
        out.insert(0, 0)
    if out[-1] != len(grid) - 1:
        out.append(len(grid) - 1)
    return out


def _mv_bez(u, x1, y1, x2, y2):
    u = np.clip(u, 0, 1); lo = np.zeros_like(u); hi = np.ones_like(u); s = u.copy()
    bx = lambda s: 3 * x1 * s * (1 - s) ** 2 + 3 * x2 * s * s * (1 - s) + s ** 3
    for _ in range(36):
        c = bx(s); lo = np.where(c < u, s, lo); hi = np.where(c >= u, s, hi); s = (lo + hi) / 2
    return 3 * y1 * s * (1 - s) ** 2 + 3 * y2 * s * s * (1 - s) + s ** 3


def _seg_ease(d, a, b, v_in, v_out):
    """one ease for samples d[a..b] whose start and end speeds ARE the measured ones (v_in, v_out per frame): only
    the handles' lengths are fitted (After Effects' speed + influence). Two moves that meet at a key then leave it at
    the speed they arrive with, so the keys never stop a move the measurement doesn't stop (STOP) or kick its speed
    (JOLT). Falls back to slopes merely pulled toward the measured ones when the speeds can't be met inside the
    curve's range."""
    seg = d[a:b + 1]; dv = seg[-1] - seg[0]
    if abs(dv) < 1e-9:
        return (1 / 3, 0.0, 2 / 3, 1.0), 0.0
    u = np.linspace(0, 1, len(seg)); y = (seg - seg[0]) / dv
    # NEVER past its keys: a segment stays between its two values (moves that turn back are split at the turn, so a
    # real overshoot is two segments). Handles outside 0..1 read as an elastic ease: the 2026-11-16 camera went past
    # its card and came back (owner: "feels like you added elastic easing", "all motion has overshoot")
    lo, hi = 0.0, 1.0
    n = b - a
    # the measured end slopes; one against the move becomes 0 (it can't be met without overshooting). Any other slope
    # is met inside 0..1 with a short enough handle (x1 <= 1/s0, 1 - x2 <= 1/s1), so speeds still carry through keys
    s0 = float(np.clip(v_in * n / dv, 0.0, 40.0)); s1 = float(np.clip(v_out * n / dv, 0.0, 40.0))
    # hard speeds: y1 = s0 x1, y2 = 1 - s1 (1 - x2); fit x1, x2 inside the y range
    x1max = 0.99 if abs(s0) < 1e-9 else min(0.99, (hi if s0 > 0 else lo) / s0)
    x2min = 0.01 if abs(s1) < 1e-9 else max(0.01, 1 - (1 - lo if s1 > 0 else 1 - hi) / s1)
    if x1max >= 0.02 and x2min <= 0.98:
        def res_h(q):
            x1, x2 = q
            return _mv_bez(u, x1, s0 * x1, x2, 1 - s1 * (1 - x2)) - y
        q0 = np.clip([min(0.33, x1max), max(0.67, x2min)], [0.01, x2min], [x1max, 0.99])
        solh = _lsq(res_h, q0, bounds=([0.01, x2min], [max(x1max, 0.0101), 0.99]), max_nfev=400)
        x1, x2 = solh.x
        # MONOTONE: a curve whose control values run 0 <= y1 <= y2 <= 1 never turns back inside its segment. y handles
        # in 0..1 alone allow y1 > y2: a rise, a stall, a rise (v5's shot-5 camera: [0.47, 0.92, 0.43, 0.0]). Shorten
        # both handles together until y1 <= y2; the speeds at the keys stay as measured.
        need = s0 * x1 + s1 * (1 - x2)
        if need > 1.0:
            k = 1.0 / need; x1 = x1 * k; x2 = 1 - (1 - x2) * k
        p = (float(x1), float(s0 * x1), float(x2), float(1 - s1 * (1 - x2)))
        err = float(np.abs((_mv_bez(u, *p) - y) * dv).max())
        return p, err
    def res(p):
        x1, y1, x2, y2 = p
        r = _mv_bez(u, *p) - y
        c0 = (y1 / max(x1, 1e-3) - s0) * 0.08
        c1 = ((1 - y2) / max(1 - x2, 1e-3) - s1) * 0.08
        return np.concatenate([r, [c0, c1]])
    p0 = np.array([0.33, min(max(s0 * 0.33, lo), hi), 0.67, min(max(1 - s1 * 0.33, lo), hi)])
    sol = _lsq(res, np.clip(p0, [0.02, lo, 0.02, lo], [0.98, hi, 0.98, hi]),
                        bounds=([0.01, lo, 0.01, lo], [0.99, hi, 0.99, hi]), max_nfev=400)
    x1, y1, x2, y2 = (float(v) for v in sol.x)
    if y1 > y2: y1 = y2 = (y1 + y2) / 2.0                 # monotone control polygon (see above)
    err = float(np.abs((_mv_bez(u, x1, y1, x2, y2) - y) * dv).max())
    return (x1, y1, x2, y2), err


def _hold_eps(rng, value, rel, noise, rot=False):
    """the smallest change the measurement can tell: 1.5 % of the track's range, at least 1 px (0.1 deg of a turn,
    0.3 % of a scale), but never more than max(4 x its noise, 10 px) (4 % of a scale): a title that drifts 24 px and
    then follows a 2000 px whip is not "still" for its first 24 px (2026-11-17)."""
    if rel:
        return max(0.003 * value, min(0.015 * rng, 0.04 * value))
    return max(0.1 if rot else 1.0, min(0.015 * rng, max(4.0 * noise, 10.0)))


def _monotone_join(d, a, b):
    """replace d[a..b] in place by one monotone cubic (Hermite) from d[a] to d[b]; the measured speeds at its ends are
    kept when they point the way of the move (Fritsch-Carlson limited, so it never overshoots), else 0."""
    n = b - a
    if n < 2:
        return
    y0, y1 = float(d[a]), float(d[b]); dv = y1 - y0
    if abs(dv) < 1e-12:
        d[a:b + 1] = y0
        return
    g = np.gradient(d); s_ = dv / n
    m0 = float(g[a]) if g[a] * s_ > 0 else 0.0
    m1 = float(g[b]) if g[b] * s_ > 0 else 0.0
    t2 = (m0 / s_) ** 2 + (m1 / s_) ** 2
    if t2 > 9.0:
        m0 *= 3.0 / np.sqrt(t2); m1 *= 3.0 / np.sqrt(t2)
    t = np.arange(n + 1) / float(n)
    d[a:b + 1] = ((2 * t ** 3 - 3 * t ** 2 + 1) * y0 + (t ** 3 - 2 * t ** 2 + t) * n * m0
                  + (-2 * t ** 3 + 3 * t ** 2) * y1 + (t ** 3 - t ** 2) * n * m1)


def _moves_group(tracks, noise=2.0, min_len=8, stop_share=0.12, extra_tol=None):
    """tracks: {name: (frames, values, rel)} of ONE layer. noise: the measurement's own scatter in px (scale: as a
    fraction, e.g. 0.004). Returns {name: keys} with shared key frames."""
    dense = {}
    for k, (fr, vals, rel) in tracks.items():
        nz = noise if not rel else (noise if noise < 0.1 else 0.004)
        dense[k] = _dense(fr, vals, rel, nz)
    f0 = max(g[0] for g, _ in dense.values()); f1 = min(g[-1] for g, _ in dense.values())
    grid = np.arange(f0, f1 + 1)
    curves = {k: np.interp(grid, g, d) for k, (g, d) in dense.items()}
    # a track that moves less than a few times its own measurement noise is still: noise must not make moves
    moving = {}
    for k, d in curves.items():
        rel = tracks[k][2]
        lim = (0.012 if rel else 3.0 * noise)
        if float(np.ptp(d)) < lim:
            curves[k] = gaussian_filter1d(d, 12.0, mode='nearest')
            moving[k] = False
        else:
            moving[k] = True
    # the tracks that decide where moves split: the ones that travel far relative to their own noise (a push is
    # its zoom, not the few-pixel drift that keeps its centre)
    snr = {k: float(np.ptp(curves[k])) / ((0.004 if tracks[k][2] else noise)) for k in curves}
    top = max(snr.values()) if snr else 1.0
    driving = [curves[k] for k in curves if moving[k] and snr[k] >= 0.35 * top] or list(curves.values())
    br = _breaks(grid, driving, min_len, stop_share)
    # one extra key per move, shared by every track of the layer, where a single ease misses by more than the
    # visible limit (at the move's joint speed peak)
    sp = sum(np.abs(np.gradient(d)) / max(float(np.ptp(d)), 1e-9) for d in driving)
    # a segment whose joint speed falls and rises again is two moves: split it at the dip (one ease can't do both)
    changed = True
    while changed:
        changed = False
        nb = [br[0]]
        for a, b in zip(br[:-1], br[1:]):
            seg = sp[a:b + 1]
            best = None
            for i in range(min_len, len(seg) - min_len):
                l, r = seg[:i].max(), seg[i + 1:].max()
                if seg[i] < 0.5 * min(l, r) and (best is None or seg[i] / min(l, r) < best[1]):
                    best = (i, seg[i] / min(l, r))
            if best is not None:
                nb.append(a + best[0]); changed = True
            nb.append(b)
        br = sorted(set(nb))
    final = [br[0]]
    # the ease is fitted on the VALUE the editor interpolates (a scale key plays linearly between its values, not in
    # log space), so the speeds matched at a key are the speeds on screen
    vals = {k: (np.exp(d) if tracks[k][2] else d) for k, d in curves.items()}
    for a, b in zip(br[:-1], br[1:]):
        worst = 0.0
        for k, d in vals.items():
            rel = tracks[k][2]; v = np.gradient(d)
            _, err = _seg_ease(d, a, b, v[a], v[b])
            tol = extra_tol or (max(3.0, 3 * noise) if not rel else 0.012 * float(np.abs(d[a:b + 1]).max()))
            worst = max(worst, err / tol)
        if worst > 1 and b - a >= 2 * min_len:
            pk = a + int(np.argmax(sp[a:b + 1]))
            if a + min_len // 2 < pk < b - min_len // 2:
                final.append(pk)
        final.append(b)
    final = sorted(set(final))
    # NO SMALL BACK-AND-FORTHS: a layer that slides "slightly left, right instead of direct smooth movements" (owner,
    # 2026-11-16) is the measurement's wobble on its MINOR axis (a card falls 600 px while its x goes +3, -2, +3). Such a
    # stretch is joined by ONE monotone curve between the neighbouring keys (their measured end speeds kept, so the keys
    # still pass the speed on). The layer's MAIN motion, its scale and its turn stay as measured, small turns included:
    # a hill that rises 18 px and sinks, bobs back 53 px; a pop to 104 % that settles. (2026-11-17: holding the small
    # side broke the data where it resumed, a 52 px step in 10 frames; joining a main-axis turn "inside the noise" made a
    # real rise crawl from rest: a "steps" window where the reference never stops.)
    px_rng = [float(np.ptp(vals[k])) for k in vals if not tracks[k][2] and 'rot' not in str(k).lower()]
    main_rng = max(px_rng) if px_rng else 0.0
    for k in list(vals):
        d = vals[k].copy(); rel = tracks[k][2]; rng = float(np.ptp(d))
        rot = (not rel) and 'rot' in str(k).lower()
        minor = (not rel) and (not rot) and rng < 0.25 * main_rng
        if not minor:
            continue      # the main motion, a scale, a turn: as measured (its creeps are held below)
        thr = max(0.15 * rng, 3.0 * max(noise, 1.0))
        # a side that moves less than a hold's limit IS a hold (a creep inside a rest): the hold rule below keeps it
        # still, so it is never a turn (joining across it would erase the rest: the camera resting on a card)
        eps = _hold_eps(rng, abs(float(np.median(d))), rel, noise, rot)
        for _ in range(len(final)):
            hit = None
            for i in range(1, len(final) - 1):
                a_, m_, b_ = final[i - 1], final[i], final[i + 1]
                da, db = d[m_] - d[a_], d[b_] - d[m_]
                if da * db < 0 and eps <= min(abs(da), abs(db)) < thr:
                    hit = (a_, b_); break
            if not hit: break
            _monotone_join(d, *hit)
        vals[k] = d
    out = {}
    for k, d in vals.items():
        v = np.gradient(d); keys = []
        for a, b in zip(final[:-1], final[1:]):
            bz, _ = _seg_ease(d, a, b, v[a], v[b])
            keys.append((float(grid[a]), float(d[a]), bz))
        keys.append((float(grid[final[-1]]), float(d[final[-1]]), None))
        # a segment that moves less than the measurement can tell is a HOLD, not a creep: settled things stay still
        # (owner, 2026-11-16: "stop this micro movements")
        rel = tracks[k][2]; rng = float(np.ptp(d)); rot = (not rel) and 'rot' in str(k).lower()
        for i in range(1, len(keys)):
            if 0 < abs(keys[i][1] - keys[i - 1][1]) < _hold_eps(rng, abs(keys[i - 1][1]), rel, noise, rot):
                keys[i] = (keys[i][0], keys[i - 1][1], keys[i][2])
        out[k] = keys
    return out




def moves(tracks, noise=2.0, min_len=8, stop_share=0.12, extra_tol=None):
    """tracks: {name: (frames, values, rel)} of ONE layer (frames in film frames, any spacing: per-frame tracks or
    sparse seeds). noise: the measurement's own scatter in px (rel tracks use 0.4 %). Returns {name: keys}, keys =
    [(frame, value, bezier_or_None)] like `fit`. Tracks with the same span share their key frames."""
    groups = {}
    for name, t in tracks.items():
        groups.setdefault((round(min(t[0])), round(max(t[0]))), {})[name] = t
    out = {}
    for g in groups.values():
        out.update(_moves_group(g, noise, min_len, stop_share, extra_tol))
    return out


def speed_peaks(keys, per_segment=24):
    """how many times the speed of a fitted track rises to a peak (prominent local maxima of |dv|): a move has one.
    More peaks than segments means the track wobbles."""
    ts, vs = [], []
    for (ta, va, bz), (tb, vb, _) in zip(keys[:-1], keys[1:]):
        u = np.linspace(0, 1, per_segment, endpoint=False)
        y = u if bz is None else bez_ease(u, *bz)
        ts.extend(ta + (tb - ta) * u); vs.extend(va + (vb - va) * np.asarray(y))
    if len(vs) < 3: return 0
    sp = np.abs(np.gradient(np.asarray(vs), np.asarray(ts))); top = sp.max() or 1
    return int(sum(1 for i in range(1, len(sp) - 1) if sp[i] > sp[i - 1] and sp[i] >= sp[i + 1] and sp[i] > 0.15 * top))

def to_glea(keys, f0, n_frames):
    """Keys in film frames -> propertyKeyframes entries (position = % of the item's played frames)."""
    out = []
    for t, v, bz in keys:
        k = {'position': round(min(100.0, max(0.0, (t - f0) / n_frames * 100)), 4), 'value': str(round(float(v), 4))}
        if bz: k.update(easing='Custom', bezier=[round(float(x), 4) for x in bz])
        else: k['easing'] = 'Linear'
        out.append(k)
    return out


# ── a project's tracks ────────────────────────────────────────────────────────────────────────────────────────────
CURVES = {}


def load_easings(path):
    """The editor's named easing curves (capabilities easings.keyframe.curves), for tracks that use them."""
    kf = json.load(open(path))
    kf = kf.get('easings', kf).get('keyframe', kf)
    CURVES.clear(); CURVES.update({c['value']: c for c in kf.get('curves', [])})
    for old, new in (kf.get('retired') or {}).items():
        if old not in CURVES and new in CURVES: CURVES[old] = CURVES[new]


def _named(name, u):
    c = CURVES[name]
    if c.get('kind') == 'sampled' and c.get('samples'):
        s = np.asarray(c['samples'], float); return np.interp(u, np.linspace(0, 1, len(s)), s)
    return bez_ease(u, *c['cubicBezier'])


def _why_not(track, keys, fx):
    if track in fx: return 'has an expression (propertyKeyframeFx)'
    for k in keys:
        if k.get('easeSlice'): return 'split slice (easeSlice)'
        if k.get('easing') == 'Hold': return 'Hold steps'
        try: float(k.get('value'))
        except (TypeError, ValueError): return 'not numeric'
    for k in keys[:-1]:
        e = k.get('easing') or 'Linear'
        if e == 'Custom' and not (isinstance(k.get('bezier'), list) and len(k['bezier']) == 4): return 'Custom key without its bezier'
        if e not in ('Linear', 'Custom') and e not in CURVES: return 'named easing %r (pass --easings)' % e
    return None


def sample_track(keys, per_segment=6):
    """The track's value at every key and at points inside each segment, on the position axis (0–100)."""
    ks = sorted(keys, key=lambda k: float(k['position'])); ps, vs = [], []
    for a, b in zip(ks[:-1], ks[1:]):
        pa, pb, va, vb = float(a['position']), float(b['position']), float(a['value']), float(b['value'])
        e = a.get('easing') or 'Linear'; n = 1 if e == 'Linear' else per_segment
        u = np.arange(n) / n
        y = u if e == 'Linear' else bez_ease(u, *a['bezier']) if e == 'Custom' else _named(e, u)
        ps.extend(pa + (pb - pa) * u); vs.extend(va + (vb - va) * np.asarray(y))
    ps.append(float(ks[-1]['position'])); vs.append(float(ks[-1]['value']))
    return np.asarray(ps), np.asarray(vs)


def refit_track(track, keys, fx=(), min_keys=8):
    """{track, keys, new_keys, max_err, tol, rel, new (the entries) or skipped (why)} for one track."""
    r = {'track': track, 'keys': len(keys)}
    if len(keys) < min_keys: r['skipped'] = 'few keys'; return r
    why = _why_not(track, keys, fx)
    if why: r['skipped'] = why; return r
    ps, vs = sample_track(keys)
    tol, rel = tolerance(track, vs); cap = len(keys) // 2
    # Hermite keys first (milliseconds); the least-squares refine only where it can beat them. A track that needs
    # more than half its keys even so is noise (a hand-held corner pin): refining it would only cost time.
    herm, herr = fit(ps, vs, tol, rel, max_keys=max(2, len(keys) - 1), refine_handles=False)
    best, err = (herm, herr) if herr <= tol else (None, herr)
    if (best is not None and len(best) <= cap or len(keys) <= 16) and len(ps) <= 600:
        lim = min(len(best), cap) if best else cap
        if lim >= 2:
            ref, rerr = fit(ps, vs, tol, rel, max_keys=lim, refine_handles=True)
            if rerr <= tol and (best is None or len(ref) < len(best)): best, err = ref, rerr
    r.update(new_keys=len(best or herm), max_err=round(err, 5), tol=tol, rel=rel)
    if best is not None and len(best) <= cap:
        r['new'] = to_glea(best, 0.0, 100.0)
    return r


def _ease_fn(k):
    """the segment's easing as a function of 0..1, or None (Hold, a split slice, an unknown named curve)."""
    e = k.get('easing') or 'Linear'
    if k.get('easeSlice') or e == 'Hold': return None
    if e == 'Linear': return lambda u: np.asarray(u, float)
    if e == 'Custom':
        bz = k.get('bezier')
        return (lambda u: bez_ease(u, *bz)) if isinstance(bz, list) and len(bz) == 4 else None
    return (lambda u: _named(e, u)) if e in CURVES else None


def seg_end_speeds(a, b):
    """(speed leaving key a, speed arriving at key b) of the segment a->b, in value per position unit; None when the
    segment has no measurable curve."""
    try: pa, pb, va, vb = float(a['position']), float(b['position']), float(a['value']), float(b['value'])
    except (KeyError, TypeError, ValueError): return None
    f = _ease_fn(a)
    if f is None or pb <= pa: return None
    m = (vb - va) / (pb - pa); h = 0.01
    return m * float(f(h) - f(0.0)) / h, m * float(f(1.0) - f(1.0 - h)) / h


MOTION_TRACKS = {t for t in TOL if t not in ('opacity', 'blur')} | {'panX', 'panY', 'zoom'}


def stop_go(track, keys, pos_per_frame=None):
    """inner keys where a move that goes on THE SAME WAY stops or changes speed abruptly:
    STOP  both segments are slow at the key (under 15 % of their own average speed): move, stop, move. On screen it
          is a step: the "scale up, rotate, then move down" the owner called stepped.
    JOLT  the speed at least halves or doubles at the key, by more than a third of the slower segment's average
          (an ease-out into a key followed by an ease that starts fast, a linear segment after an eased one): a kick.
          With pos_per_frame (position units per frame) a jump under the track's tolerance per frame is ignored.
    A turn (the value comes back) and a hold (equal values) are not flagged. Returns [{index, position, kind, v_in,
    v_out, avg_in, avg_out}] (speeds in value per position unit)."""
    ks = sorted((k for k in keys if isinstance(k, dict)), key=lambda k: float(k.get('position', 0)))
    if len(ks) < 3: return []
    try: vals = [float(k['value']) for k in ks]
    except (KeyError, TypeError, ValueError): return []
    tol, rel = tolerance(track, vals)
    sl = [seg_end_speeds(a, b) for a, b in zip(ks[:-1], ks[1:])]
    out = []
    for i in range(1, len(ks) - 1):
        L, R = sl[i - 1], sl[i]
        if L is None or R is None: continue
        dl, dr = vals[i] - vals[i - 1], vals[i + 1] - vals[i]
        lim = 2 * (tol * max(abs(vals[i]), 1e-6) if rel else tol)
        if abs(dl) <= lim or abs(dr) <= lim or (dl > 0) != (dr > 0): continue
        pl = float(ks[i]['position']) - float(ks[i - 1]['position']); pr = float(ks[i + 1]['position']) - float(ks[i]['position'])
        if pl <= 0 or pr <= 0: continue
        avl, avr = abs(dl) / pl, abs(dr) / pr
        vin, vout = abs(L[1]), abs(R[0]); jump = abs(vin - vout)
        floor = 0.0
        if pos_per_frame: floor = (tol * abs(vals[i]) if rel else tol) / pos_per_frame   # under one tolerance per frame: invisible
        if vin <= 0.15 * avl and vout <= 0.15 * avr: kind = 'STOP'
        elif jump > 0.5 * max(vin, vout) and jump > 0.35 * min(avl, avr) and jump > floor: kind = 'JOLT'
        else: continue
        out.append({'index': i, 'position': float(ks[i]['position']), 'kind': kind, 'v_in': vin, 'v_out': vout,
                    'avg_in': avl, 'avg_out': avr})
    return out


def stop_go_tracks(data, fps=30.0, items=None, tracks=None):
    """every STOP / JOLT in a project (top level and inside sequences), speeds per frame."""
    out = []
    for seq, it in _items(data):
        if items and it.get('id') not in items: continue
        n = _frames(it, fps) or 100.0; fx = it.get('propertyKeyframeFx') or {}
        for track, keys in (it.get('propertyKeyframes') or {}).items():
            if tracks and track not in tracks or not isinstance(keys, list) or track in fx: continue
            if not tracks and track not in MOTION_TRACKS: continue     # a typing progress or a fade keeps its rhythm
            pf = 100.0 / n              # position units per frame
            for s in stop_go(track, keys, pf):
                out.append(dict(item=it.get('id'), name=it.get('customName') or it.get('name') or '', sequence=seq,
                                track=track, kind=s['kind'], key=s['index'], frame=round(s['position'] / pf, 1),
                                v_in=round(s['v_in'] * pf, 3), v_out=round(s['v_out'] * pf, 3),
                                avg_in=round(s['avg_in'] * pf, 3), avg_out=round(s['avg_out'] * pf, 3)))
    return out


def over_tracks(data, items=None, tracks=None):
    """every motion key whose Custom curve goes PAST the next key's value (a bezier y handle outside 0..1): on screen an
    elastic or back ease, the layer passing its mark and coming back. Named curves (Overshoot, Back, Elastic) are the
    deliberate kind and are not listed."""
    out = []
    for seq, it in _items(data):
        if items and it.get('id') not in items: continue
        for track, keys in (it.get('propertyKeyframes') or {}).items():
            if tracks and track not in tracks or not isinstance(keys, list): continue
            if not tracks and track not in MOTION_TRACKS: continue
            ks = sorted((k for k in keys if isinstance(k, dict)), key=lambda k: float(k.get('position', 0)))
            for i, k in enumerate(ks[:-1]):
                bz = k.get('bezier')
                if not (k.get('easing') == 'Custom' and isinstance(bz, list) and len(bz) == 4): continue
                over = min(bz[1], bz[3]) < -0.02 or max(bz[1], bz[3]) > 1.02
                stall = bz[1] > bz[3] + 0.02          # the control polygon turns back: a rise, a stall, a rise
                if over or stall:
                    try:
                        if abs(float(ks[i + 1]['value']) - float(k['value'])) < 1e-6: continue
                    except (KeyError, TypeError, ValueError): continue
                    out.append(dict(item=it.get('id'), name=it.get('customName') or '', sequence=seq, track=track, key=i,
                                    kind='OVER' if over else 'STALL', bezier=[round(float(x), 3) for x in bz]))
    return out


def _stop_line(r):
    where = ('%s/' % r['sequence'] if r['sequence'] else '') + '%s %s.%s' % (r['item'], ('"%s"' % r['name']) if r['name'] else '', r['track'])
    what = ('eases to a stop and starts again the same way' if r['kind'] == 'STOP' else
            'changes speed at once')
    return ('  %s   %s, key %d (item frame %g): %s (arrives at %g/f, leaves at %g/f; the moves average %g and %g/f)'
            % (r['kind'], where, r['key'], r['frame'], what, r['v_in'], r['v_out'], r['avg_in'], r['avg_out']))


def _items(data):
    for ch in data.get('channels', []):
        for it in ch.get('items', []): yield '', it
    for clip in data.get('clips', []):
        seq = clip.get('sequence')
        if isinstance(seq, dict):
            for path, it in _items(seq): yield (clip.get('id') or '?') + (('/' + path) if path else ''), it


def _frames(it, fps):
    try:
        speed = float(it.get('speed') or 1) or 1
        return max(1e-6, (float(it['trimEnd']) - float(it.get('trimStart') or 0)) / speed * fps)
    except (KeyError, TypeError, ValueError): return None


def thin_item(item, tracks=None, min_keys=8):
    """Refit the item's dense tracks IN PLACE (only where half the keys or fewer stay within tolerance). Returns the
    per-track reports. Idempotent: a fitted track has too few keys to be touched again."""
    pk = item.get('propertyKeyframes') or {}; fx = item.get('propertyKeyframeFx') or {}; out = []
    for track, keys in list(pk.items()):
        if tracks and track not in tracks or not isinstance(keys, list): continue
        r = refit_track(track, keys, fx, min_keys)
        if 'new' in r: pk[track] = r['new']
        out.append(r)
    return out


def dense_tracks(data, min_keys=8, fps=30.0, items=None, tracks=None):
    """Every track with ≥ min_keys keys, with what a refit would make of it (read-only)."""
    out = []
    for seq, it in _items(data):
        if items and it.get('id') not in items: continue
        n = _frames(it, fps); pk = it.get('propertyKeyframes') or {}; fx = it.get('propertyKeyframeFx') or {}
        for track, keys in pk.items():
            if tracks and track not in tracks or not isinstance(keys, list) or len(keys) < min_keys: continue
            r = refit_track(track, keys, fx, min_keys); r.update(item=it.get('id'), name=it.get('customName') or it.get('name') or '', sequence=seq)
            if n: r['frames_per_key'] = round(n / max(1, len(keys) - 1), 2)
            out.append(r)
    return out


def _load_project(path):
    j = json.load(open(path)); return j, (j['data'] if isinstance(j.get('data'), dict) else j)


def _line(r):
    where = ('%s/' % r['sequence'] if r['sequence'] else '') + '%s %s.%s' % (r['item'], ('"%s"' % r['name']) if r['name'] else '', r['track'])
    fpk = (', a key every %.1f frames' % r['frames_per_key']) if r.get('frames_per_key') else ''
    if 'skipped' in r: return '  keep   %s: %d keys%s, %s' % (where, r['keys'], fpk, r['skipped'])
    tol = ('%.2f %%' % (r['tol'] * 100)) if r['rel'] else '%g' % r['tol']
    verdict = 'THIN  ' if 'new' in r else 'ok    '
    return '  %s %s: %d keys%s -> %d keys (max miss %g, tolerance %s)' % (verdict, where, r['keys'], fpk, r['new_keys'], r['max_err'], tol)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    c = sub.add_parser('curve'); c.add_argument('curve'); c.add_argument('--tol', type=float, required=True); c.add_argument('--rel', action='store_true')
    c.add_argument('--max-keys', type=int, default=10); c.add_argument('--no-refine', action='store_true')
    c.add_argument('--item-f0', type=float); c.add_argument('--item-frames', type=float); c.add_argument('--out', required=True)
    m = sub.add_parser('moves', help='measured tracks of one layer -> moves (2 keys + one ease each), shared key frames')
    m.add_argument('tracks', help='{"translateX": {"frames": [...], "values": [...], "rel": false}, ...}')
    m.add_argument('--noise', type=float, default=2.0, help="the measurement's scatter in px: trackers 1-3, blobs 3-5, hand-read seeds 8-15")
    m.add_argument('--item-f0', type=float); m.add_argument('--item-frames', type=float); m.add_argument('--out', required=True)
    for name in ('check', 'thin'):
        p = sub.add_parser(name); p.add_argument('project'); p.add_argument('--min-keys', type=int, default=8); p.add_argument('--fps', type=float, default=30.0)
        p.add_argument('--easings'); p.add_argument('--items', default=''); p.add_argument('--tracks', default='')
        if name == 'thin': p.add_argument('--out', required=True)
        if name == 'check':
            p.add_argument('--strict', action='store_true', help='also fail on MANY (a track with --min-keys or more keys, on average under 0.4 s apart, that is not Hold steps, an expression or a split: keys on a tracker noise) and on STOP / JOLT keys')
            p.add_argument('--allow-stops', default='', help='item ids whose STOP keys are the reference\'s own stops (measured, named in your report); JOLT is never allowed')
            p.add_argument('--allow-over', default='', help='item ids whose Custom overshoot is deliberate (a pop the reference makes)')
    a = ap.parse_args()
    if a.cmd == 'moves':
        j = json.load(open(a.tracks))
        tr = {k: (v['frames'], v['values'], bool(v.get('rel'))) for k, v in j.items()}
        res = moves(tr, a.noise)
        out = {}
        for k, keys in res.items():
            o = {'keys': [{'frame': round(t, 3), 'value': round(val, 5), 'bezier': None if bz is None else [round(x, 4) for x in bz]} for t, val, bz in keys],
                 'speed_peaks': speed_peaks(keys)}
            if a.item_f0 is not None and a.item_frames: o['propertyKeyframes'] = to_glea(keys, a.item_f0, a.item_frames)
            out[k] = o
            print('%-12s %d keys, %d moves, speed peaks %d' % (k, len(keys), len(keys) - 1, o['speed_peaks']))
        json.dump(out, open(a.out, 'w'), indent=1); print('->', a.out)
        return
    if a.cmd == 'curve':
        j = json.load(open(a.curve))
        f, v = (j['frames'], j['values']) if isinstance(j, dict) else zip(*j)
        keys, err = fit(list(f), list(v), a.tol, a.rel, a.max_keys, not a.no_refine)
        out = {'max_err': round(err, 5), 'rel': a.rel, 'keys': [{'frame': round(t, 3), 'value': round(val, 4), 'bezier': None if bz is None else [round(x, 4) for x in bz]} for t, val, bz in keys]}
        if a.item_f0 is not None and a.item_frames: out['propertyKeyframes'] = to_glea(keys, a.item_f0, a.item_frames)
        json.dump(out, open(a.out, 'w'), indent=1)
        print('%d keys, max miss %g%s -> %s' % (len(keys), err, ' (relative)' if a.rel else '', a.out))
        if err > a.tol: print('  the curve still misses by more than --tol at %d keys: raise --max-keys, or the curve is noisy (smooth it) or two moves in one' % a.max_keys)
        return
    if a.easings: load_easings(a.easings)
    items = set(x for x in a.items.split(',') if x) or None; tracks = set(x for x in a.tracks.split(',') if x) or None
    j, data = _load_project(a.project)
    if a.cmd == 'check':
        rs = dense_tracks(data, a.min_keys, a.fps, items, tracks); bad = [r for r in rs if 'new' in r]
        # MANY: 8+ keys that sit close together (on average under 0.4 s apart): keys on a tracker's noise. A long
        # camera through several real moves (a whip, a tilt, a push) has its keys far apart: listed as LONG, not failed
        many = [r for r in rs if 'new' not in r and 'skipped' not in r and (r.get('frames_per_key') or 0) < 0.4 * a.fps]
        long_ = [r for r in rs if 'new' not in r and 'skipped' not in r and r not in many]
        for r in rs:
            line = _line(r)
            if r in many: line = line.replace('  ok     ', '  MANY   ')
            elif r in long_: line = line.replace('  ok     ', '  LONG   ') + ' (keys %.2f s apart: moves, not samples; check each is one of the reference\'s)' % (r['frames_per_key'] / a.fps)
            print(line)
        print('%d tracks with >= %d keys; %d can be written with half the keys or fewer%s' % (len(rs), a.min_keys, len(bad), ': run thin, or fit them in your builder' if bad else ''))
        if many: print('%d tracks have %d+ keys (MANY): a measured track is its moves, 2 keys and one ease each; refit it with `keyfit.py moves` (or keyfit.moves in the builder)' % (len(many), a.min_keys))
        allowed = set(x for x in a.allow_stops.split(',') if x)
        sg = stop_go_tracks(data, a.fps, items, tracks)
        for r in sg: print(_stop_line(r) + ('   (allowed: the reference stops here)' if r['kind'] == 'STOP' and r['item'] in allowed else ''))
        sg_bad = [r for r in sg if not (r['kind'] == 'STOP' and r['item'] in allowed)]
        if sg_bad:
            print('%d keys stop a move that goes on the same way, or kick its speed (STOP / JOLT): on screen a step. One gesture is '
                  'one segment with one ease (drop the inner key), or the speed carries through the key (the ease into it ends at '
                  'the speed the next one starts with). A parent\'s keys count: a child rides every step of its parent.' % len(sg_bad))
        allowed_o = set(x for x in a.allow_over.split(',') if x)
        ov = [r for r in over_tracks(data, items, tracks) if r['item'] not in allowed_o]
        for r in ov:
            where = ('%s/' % r['sequence'] if r['sequence'] else '') + '%s %s.%s' % (r['item'], ('"%s"' % r['name']) if r['name'] else '', r['track'])
            print('  %-6s %s, key %d: bezier %s %s' % (r['kind'], where, r['key'], r['bezier'],
                  'goes past the next key and comes back: an elastic look' if r['kind'] == 'OVER' else 'rises, stalls and rises again inside one move'))
        if ov: print('%d keys overshoot (OVER) or stall (STALL): keep each segment between its keys and its handles in order (y1 <= y2)' % len(ov))
        sys.exit(1 if bad or (a.strict and (many or sg_bad or ov)) else 0)
    data2 = copy.deepcopy(data); n = 0
    for seq, it in _items(data2):
        if items and it.get('id') not in items: continue
        for r in thin_item(it, tracks, a.min_keys):
            r.update(item=it.get('id'), name=it.get('customName') or '', sequence=seq); print(_line(r)); n += 'new' in r
    if data is j: j2 = data2
    else: j2 = dict(j); j2['data'] = data2
    json.dump(j2, open(a.out, 'w'), indent=1)
    print('%d tracks thinned -> %s' % (n, a.out))


if __name__ == '__main__':
    main()
