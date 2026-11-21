#!/usr/bin/env python3
"""seam_check.py — check every seam (join between two shots) of a render by numbers: does the picture's motion keep its
direction and speed across the seam, does the cut sit on the move's peak, is there a stop-start, a still side, a dead
frame, a cut that is too sharp. Spec: seam-check.md.

  seam_check.py RENDER.mp4 [--project-json P.json] [--seams auto|f1,f2,…] [--out DIR]
                [--anchor F:x,y,w,h …] [--mask x,y,w,h …] [--film-offset N] [--no-sheets]

  --seams auto (default)  hard cuts (HSV histogram + SSIM: a frame unlike its predecessor while its successors are
                          alike) plus, with --project-json, every top-level item boundary and cross-transition midpoint.
  --seams 120,348,…       exact seam frames (the first frame of the incoming shot), in render frames.
  --project-json          a project GET ({data, version}) or its `data`; its times are film times. With a range
                          render pass --film-offset (the film frame of render frame 0) so they line up.
  --anchor F:x,y,w,h      an element kept across seam F (render px, top-left x,y): template-matched F−1 → F,
                          multi-scale → centre Δ px and scale (band ≤ 30 px, ×0.95–1.3).
  --mask x,y,w,h          ignore a static overlay (a watermark, a fixed caption) when measuring the global motion.

Out: DIR/seams.json (every metric, per-frame speeds F−12…F+12, verdict, fix), DIR/SEAMS.md (the table) and
DIR/sheets/seam_FFFF.jpg (F as 4 digits; frames F−3…F+3, motion arrows, F ringed); DIR defaults to <render>_seams/.
Exit code 0; read the verdicts.

Units: pan px/f in the render's own pixels, zoom %/f, rotation °/f. Row f = the motion from frame f−1 to f. The px
thresholds of the spec are for a 1920-px-wide frame and scale with the render width (×W/1920).
Motion: a 640-px-wide grey copy, lightly blurred; LK corners + forward-backward check + RANSAC similarity
(estimateAffinePartial2D); too few corners → phase correlation (pan only, method "phase").
"""
import argparse, json, math, os, sys

import cv2
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
import timeline  # noqa: E402  (item layout shared with seam_fit.py)

MW = 640                     # width of the measuring copy
SMALL = (256, 144)           # cut / hold scan copy (w, h); portrait renders swap it
REF_W = 1920.0               # px thresholds below are for a 1920-wide frame

# thresholds (seam-check.md); PX ones are scaled by W/1920
TH = dict(
    pan_move=1.5,            # px/f: a side "moves" (for dir_cos)
    zoom_move=0.15,          # %/f
    dir_pass=0.7, dir_warn=0.4,
    pan_ratio=(0.8, 1.5), zoom_ratio=(1.0, 2.4), ratio_warn=(0.5, 3.0),
    peak_pass=2, peak_warn=4, peak_win=10,
    stop_frac=0.25, stop_win=12,
    still_pan=0.3, still_zoom=0.1, still_n=6,
    luma_jump=60.0, black=20.0,
    hold_mad=0.4, hold_win=8, hold_maxrun=3,
    anchor_px=30.0, anchor_scale=(0.95, 1.3),
)


# ── decoding and per-frame measurement ────────────────────────────────────────────────────────────────────────────
def _ssim(a, b):
    c1, c2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2
    a, b = a.astype(np.float64), b.astype(np.float64)
    mu_a, mu_b = cv2.GaussianBlur(a, (7, 7), 1.5), cv2.GaussianBlur(b, (7, 7), 1.5)
    sa = cv2.GaussianBlur(a * a, (7, 7), 1.5) - mu_a ** 2
    sb = cv2.GaussianBlur(b * b, (7, 7), 1.5) - mu_b ** 2
    sab = cv2.GaussianBlur(a * b, (7, 7), 1.5) - mu_a * mu_b
    m = ((2 * mu_a * mu_b + c1) * (2 * sab + c2)) / ((mu_a ** 2 + mu_b ** 2 + c1) * (sa + sb + c2))
    return float(m.mean())


class Measurer:
    def __init__(self, W, H, masks):
        self.W, self.H = W, H
        self.s = MW / float(W)                         # render px -> measuring px
        self.mh = int(round(H * self.s))
        self.mask = np.full((self.mh, MW), 255, np.uint8)
        for (x, y, w, h) in masks:
            x0, y0 = int(x * self.s), int(y * self.s); x1, y1 = int((x + w) * self.s) + 1, int((y + h) * self.s) + 1
            self.mask[max(0, y0):y1, max(0, x0):x1] = 0
        self.win = cv2.createHanningWindow((MW, self.mh), cv2.CV_32F)
        self.small = SMALL if W >= H else (SMALL[1], SMALL[0])

    def prep(self, im):
        g = cv2.cvtColor(im, cv2.COLOR_BGR2GRAY)
        m = cv2.GaussianBlur(cv2.resize(g, (MW, self.mh), interpolation=cv2.INTER_AREA), (3, 3), 0.8)
        sm = cv2.GaussianBlur(cv2.resize(g, self.small, interpolation=cv2.INTER_AREA), (5, 5), 0).astype(np.float32)
        hsv = cv2.cvtColor(cv2.resize(im, self.small, interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2HSV)
        hist = cv2.calcHist([hsv], [0, 1, 2], None, [16, 8, 8], [0, 180, 0, 256, 0, 256]); cv2.normalize(hist, hist)
        return dict(m=m, sm=sm, hist=hist, luma=float(g.mean()))

    @staticmethod
    def _sim(M, cx, cy, k):
        c = M @ np.array([cx, cy, 1.0]); sc = math.hypot(M[0, 0], M[1, 0])
        return dict(vx=round(float(c[0] - cx) * k, 3), vy=round(float(c[1] - cy) * k, 3), zoom=round((sc - 1) * 100, 4),
                    rot=round(math.degrees(math.atan2(M[1, 0], M[0, 0])), 4))

    def motion(self, a, b):
        """global similarity a -> b (measuring px) -> dict(vx, vy px/f render px, zoom %/f, rot °/f, n, method)"""
        k = 1.0 / self.s
        cx, cy = MW / 2.0, self.mh / 2.0
        p0 = cv2.goodFeaturesToTrack(a, 800, 0.005, 5, mask=self.mask, blockSize=5)
        if p0 is not None and len(p0) >= 12:
            p1, st, _ = cv2.calcOpticalFlowPyrLK(a, b, p0, None, winSize=(21, 21), maxLevel=4)
            pb, st2, _ = cv2.calcOpticalFlowPyrLK(b, a, p1, None, winSize=(21, 21), maxLevel=4)
            ok = (st.ravel() == 1) & (st2.ravel() == 1) & (np.linalg.norm((pb - p0).reshape(-1, 2), axis=1) < 0.5)
            if ok.sum() >= 8:
                M, inl = cv2.estimateAffinePartial2D(p0[ok], p1[ok], method=cv2.RANSAC, ransacReprojThreshold=0.7,
                                                     maxIters=3000, confidence=0.995)
                # a fit on a handful of points, or with most points off it, is a cut / a mixed frame, not a camera move
                if M is not None and int(inl.sum()) >= 12 and (float(inl.mean()) >= 0.35 or int(inl.sum()) >= 40):
                    r = self._sim(M, cx, cy, k); r.update(n=int(inl.sum()), inl=round(float(inl.mean()), 3), method="lk")
                    # a slow dominant layer (a static wall) with a large coherent layer moving much faster over it (a
                    # row of screens sliding): the eye follows the moving layer. Small layers (a cursor) stay ignored.
                    a_o, b_o = p0[ok][inl.ravel() == 0], p1[ok][inl.ravel() == 0]
                    pt, zt = TH["pan_move"] * self.W / REF_W, TH["zoom_move"]
                    nrm = lambda q: max(math.hypot(q["vx"], q["vy"]) / pt, abs(q["zoom"]) / zt)
                    if len(a_o) >= max(20, 0.2 * ok.sum()):
                        M2, in2 = cv2.estimateAffinePartial2D(a_o, b_o, method=cv2.RANSAC, ransacReprojThreshold=0.7,
                                                              maxIters=3000, confidence=0.995)
                        if M2 is not None and int(in2.sum()) >= max(20, 0.2 * ok.sum()):
                            r2 = self._sim(M2, cx, cy, k)
                            if nrm(r2) >= 4 * max(1.0, nrm(r)):
                                r2.update(n=int(in2.sum()), inl=round(float(in2.sum()) / ok.sum(), 3), method="lk-layer",
                                          bg=dict(vx=r["vx"], vy=r["vy"], zoom=r["zoom"], n=r["n"]))
                                return r2
                    return r
        # flat graphic frame: phase correlation, pan only — kept only when the shift really aligns the two frames
        # (across a cut the correlation peak is noise)
        (dx, dy), resp = cv2.phaseCorrelate(a.astype(np.float32), b.astype(np.float32), self.win)
        if resp > 0.15 and abs(dx) < MW / 3 and abs(dy) < self.mh / 3:
            Mt = np.float32([[1, 0, dx], [0, 1, dy]])
            wa = cv2.warpAffine(a, Mt, (MW, self.mh), borderMode=cv2.BORDER_REPLICATE)
            m = 4 + int(abs(dx)) + 1, 4 + int(abs(dy)) + 1
            inner = (slice(m[1], self.mh - m[1]), slice(m[0], MW - m[0]))
            al = float(np.abs(wa[inner].astype(np.float32) - b[inner]).mean())
            raw = float(np.abs(a[inner].astype(np.float32) - b[inner]).mean())
            if resp >= 0.5 or al < 3.0 or (raw > 0 and al < 0.5 * raw and al < 8.0):
                return dict(vx=round(dx * k, 3), vy=round(dy * k, 3), zoom=0.0, rot=0.0, n=0, inl=round(float(resp), 3),
                            method="phase")
        return dict(vx=None, vy=None, zoom=None, rot=None, n=0, inl=0.0, method="none")


def scan(path, masks):
    """pass 1: per-frame rows (motion f-1 -> f, cut scan, luma)"""
    cap = cv2.VideoCapture(path)
    if not cap.isOpened(): sys.exit(f"cannot open {path}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    W, H = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    me = Measurer(W, H, masks)
    rows, prev = [], None
    f = 0
    while True:
        ok, im = cap.read()
        if not ok: break
        cur = me.prep(im)
        r = dict(f=f, luma=round(cur["luma"], 1))
        if prev is not None:
            r.update(me.motion(prev["m"], cur["m"]))
            r["mad"] = round(float(np.abs(cur["sm"] - prev["sm"]).mean()), 3)
            r["ssim"] = round(_ssim(cur["sm"], prev["sm"]), 3)
            r["hc"] = round(float(cv2.compareHist(cur["hist"], prev["hist"], cv2.HISTCMP_CORREL)), 3)
        rows.append(r); prev = cur; f += 1
    cap.release()
    if len(rows) < 3: sys.exit("render too short")
    # a pair that is a picture change: unlike (scan rule) and the motion model does not hold across it
    for r in rows[1:]:
        unlike = (r["ssim"] < 0.55 and r["hc"] < 0.85) or r["mad"] > 25 or r["hc"] < 0.5
        tracked = r["method"] in ("lk", "lk-layer") and r["n"] >= 30 and r["inl"] >= 0.3
        r["cut"] = bool(unlike and not tracked)
    rows[0]["cut"] = False
    # cuts the histograms miss because the craft hides them (a motion-matched cut): the motion model breaks for ONE
    # row between two well-tracked rows — a jump (a scale step), no fit at all, or a collapse of the tracked points
    pt = TH["pan_move"] * W / REF_W
    nrm = lambda r: max(math.hypot(r["vx"], r["vy"]) / pt, abs(r["zoom"]) / TH["zoom_move"])
    good = lambda r: r.get("method") in ("lk", "lk-layer") and r.get("n", 0) >= 100
    for i in range(2, len(rows) - 1):
        r, p, q = rows[i], rows[i - 1], rows[i + 1]
        if r["cut"] or not (good(p) and good(q)) or r["mad"] < 8: continue
        if r.get("vx") is None:
            r["cut"], r["cut_why"] = True, "motion break"
        elif nrm(r) >= 4 * max(1.0, nrm(p), nrm(q)) and r["mad"] >= 12:
            r["cut"], r["cut_why"] = True, "jump"
        elif r["n"] < 0.25 * min(p["n"], q["n"]) and r["mad"] >= 12 and r["mad"] >= 1.5 * max(p["mad"], q["mad"]):
            r["cut"], r["cut_why"] = True, "tracked points collapse"
    return rows, fps, W, H, me


def grab(path, frames):
    """pass 2: the full frames needed for sheets / anchors"""
    need = set(frames); out = {}
    cap = cv2.VideoCapture(path); f = 0
    while need:
        ok, im = cap.read()
        if not ok: break
        if f in need: out[f] = im; need.discard(f)
        f += 1
    cap.release()
    return out


# ── seams ─────────────────────────────────────────────────────────────────────────────────────────────────────────
def auto_cuts(rows):
    """hard cuts: runs of 1–2 'cut' pairs with alike successors; a run of 3+ is fast motion, not a cut"""
    out, i, n = [], 1, len(rows)
    while i < n:
        if rows[i]["cut"]:
            j = i
            while j + 1 < n and rows[j + 1]["cut"]: j += 1
            if j - i + 1 <= 2:
                if out and i - out[-1]["cut_rows"][-1] <= 3:      # a second change within 3 f: the same seam
                    out[-1]["cut_rows"] += list(range(i, j + 1))
                else:
                    out.append(dict(f=i, cut_rows=list(range(i, j + 1)), source="cut"))
            i = j + 1
        else:
            i += 1
    return out


SKIP_TYPES = ("audio", "camera", "null", "adjustment")


def project_seams(pj, fps, offset, nframes):
    j = json.load(open(pj)); d = j["data"] if isinstance(j.get("data"), dict) else j
    seams = []
    for ch, it, a, b, clip, tw in timeline.layout(d.get("channels", []), timeline.clips(d)):
        if ch.get("kind") == "camera" or clip.get("mediaType") in SKIP_TYPES: continue
        name = it.get("customName") or clip.get("name") or it.get("id")
        for t, what in ((a, "start"), (b, "end")):
            f = int(round(t * fps)) - offset
            if 2 <= f <= nframes - 3: seams.append(dict(f=f, source="item", what=f"{name} {what}", item=it.get("id")))
        if tw:
            f = int(round((tw[0] + tw[1]) / 2 * fps)) - offset
            if 2 <= f <= nframes - 3:
                seams.append(dict(f=f, source="transition", what=f"{it.get('transition')} into {name}", item=it.get("id"),
                                  transition=[round(tw[0] * fps) - offset, round(tw[1] * fps) - offset]))
    return seams


def merge_seams(cuts, extra, tol=2):
    out = [dict(s) for s in cuts]
    for s in sorted(extra, key=lambda x: x["f"]):
        near = [c for c in out if abs(c["f"] - s["f"]) <= tol]
        if near:
            c = near[0]; c.setdefault("also", []).append(s.get("what") or s["source"])
            if s["source"] == "transition": c["source"] = "transition"; c["transition"] = s.get("transition")
            if s.get("item"): c.setdefault("items", []).append(s["item"])
        else:
            s = dict(s); s.setdefault("cut_rows", []); out.append(s)
    out.sort(key=lambda x: x["f"])
    return out


# ── metrics ───────────────────────────────────────────────────────────────────────────────────────────────────────
def valid(r):
    return r is not None and not r.get("cut") and r.get("vx") is not None


def _mean(rs, key):
    v = [r[key] for r in rs]
    return float(np.mean(v)) if v else 0.0


def side_vec(rows, fs):
    rs = [rows[f] for f in fs if 0 < f < len(rows) and valid(rows[f])]
    if not rs: return None
    vx, vy, z, ro = _mean(rs, "vx"), _mean(rs, "vy"), _mean(rs, "zoom"), _mean(rs, "rot")
    return dict(vx=round(vx, 3), vy=round(vy, 3), v=round(math.hypot(vx, vy), 3), zoom=round(z, 4), rot=round(ro, 4),
                rows=[r["f"] for r in rs], methods=sorted(set(r["method"] for r in rs)))


def series(rows, lo, hi, comp):
    """per-row speed of a component (pan |v| px/f or |zoom| %/f) on lo..hi; cut / unmeasured rows bridged by the mean
    of their nearest measured neighbours (the cut pair carries no motion of its own)"""
    raw = {}
    for f in range(lo, hi + 1):
        r = rows[f] if 0 < f < len(rows) else None
        raw[f] = None if not valid(r) else (math.hypot(r["vx"], r["vy"]) if comp == "pan" else abs(r["zoom"]))
    out = {}
    for f in range(lo, hi + 1):
        if raw[f] is not None: out[f] = raw[f]; continue
        a = next((raw[g] for g in range(f - 1, lo - 1, -1) if raw.get(g) is not None), None)
        b = next((raw[g] for g in range(f + 1, hi + 1) if raw.get(g) is not None), None)
        nb = [x for x in (a, b) if x is not None]
        out[f] = float(np.mean(nb)) if nb else None
    return out


def peak_of(sp, F, thr, near=6, win=TH["peak_win"], frac=0.12, valley=0.4):
    """the move through the seam and its peak row within F±win, minus F. The move is one hump of the speed curve: it
    starts at the seam when the seam itself moves (≥ 25 % of the fastest row within ±near), else at that fastest row
    (a stop at the seam), and grows outwards while the speed stays above 12 % of the hump's peak and does not climb
    again after a valley (< 40 % of the peak so far: that is the next move). None when nothing near the seam moves."""
    near_v = [(sp[f], f) for f in range(F - near, F + near + 1) if sp.get(f) is not None]
    if not near_v: return None
    pk, fpk = max(near_v)
    if pk < thr: return None
    at = [sp[f] for f in (F - 1, F, F + 1) if sp.get(f) is not None]
    start = F if at and max(at) >= 0.25 * pk else fpk
    if start == F and sp.get(F) is None: start = max(((sp[f], f) for f in (F - 1, F + 1) if sp.get(f) is not None))[1]
    seg = {start}
    for step in (-1, 1):
        f, top, low = start, sp[start], sp[start]
        while True:
            g = f + step
            v = sp.get(g)
            if v is None: break
            top = max(top, v)
            if v <= frac * top: break
            if low < valley * top and v > low * 1.15 + 1e-9: break      # climbing out of a valley: another move
            low = min(low, v); seg.add(g); f = g
    cand = [(sp[f], f) for f in seg if F - win <= f <= F + win]
    if not cand: return None
    return max(cand)[1] - F


def holds_near(rows, F, cut_rows):
    """rows with (almost) identical consecutive frames within ±8 f; isolated runs (≤ 3) between moving rows are dead
    frames (holds); longer runs are a still side"""
    lo, hi = max(1, F - TH["hold_win"]), min(len(rows) - 1, F + TH["hold_win"])
    same = [f for f in range(lo, hi + 1) if f not in cut_rows and rows[f].get("mad", 99) < TH["hold_mad"]]
    runs, cur = [], []
    for f in same:
        if cur and f == cur[-1] + 1: cur.append(f)
        else:
            if cur: runs.append(cur)
            cur = [f]
    if cur: runs.append(cur)
    holds, static = [], []
    for r in runs:
        before, after = r[0] - 1, r[-1] + 1
        moving = lambda f: 0 < f < len(rows) and f not in cut_rows and rows[f].get("mad", 0) >= TH["hold_mad"]
        if len(r) <= TH["hold_maxrun"] and moving(before) and moving(after): holds += r
        else: static += r
    return holds, static


def anchor_match(frames, F, box, W, H):
    a, b = frames.get(F - 1), frames.get(F)
    if a is None or b is None: return None
    ga, gb = cv2.cvtColor(a, cv2.COLOR_BGR2GRAY), cv2.cvtColor(b, cv2.COLOR_BGR2GRAY)
    x, y, w, h = [int(v) for v in box]
    T = ga[max(0, y):y + h, max(0, x):x + w]
    if T.size == 0: return None
    best = None
    for s in np.geomspace(0.7, 1.6, 37):
        tw, th = int(T.shape[1] * s), int(T.shape[0] * s)
        if tw < 8 or th < 8 or tw >= gb.shape[1] or th >= gb.shape[0]: continue
        Ts = cv2.resize(T, (tw, th), interpolation=cv2.INTER_AREA if s < 1 else cv2.INTER_CUBIC)
        res = cv2.matchTemplate(gb, Ts, cv2.TM_CCOEFF_NORMED); _, mv, _, ml = cv2.minMaxLoc(res)
        if best is None or mv > best["score"]:
            best = dict(score=round(float(mv), 3), scale=round(float(s), 4), x=ml[0] + tw / 2, y=ml[1] + th / 2)
    if best is None: return None
    c0 = (x + T.shape[1] / 2, y + T.shape[0] / 2)
    dx = math.hypot(best["x"] - c0[0], best["y"] - c0[1])
    return dict(box=box, centre_dx=round(dx, 1), scale=best["scale"], score=best["score"],
                ok=bool(dx <= TH["anchor_px"] * W / REF_W and TH["anchor_scale"][0] <= best["scale"] <= TH["anchor_scale"][1]))


def measure(rows, s, W, H, fps, anchors, frames, offset):
    px = W / REF_W
    F = s["f"]; cut_rows = set(s.get("cut_rows", []))
    for f in cut_rows:
        if 0 < f < len(rows): rows[f]["cut"] = True
    hard = bool(cut_rows)
    out = side_vec(rows, range(F - 3, F))
    inn = side_vec(rows, range(F, F + 3))
    rec = dict(f=F, film_f=F + offset, t=round((F + offset) / fps, 3), source=s["source"], hard_cut=hard,
               cut_rows=sorted(cut_rows), what=s.get("what"), also=s.get("also"), items=s.get("items") or ([s["item"]] if s.get("item") else None),
               transition=s.get("transition"), out=out, **{"in": inn})
    pan_thr, zoom_thr = TH["pan_move"] * px, TH["zoom_move"]
    o = out or dict(vx=0, vy=0, v=0, zoom=0); i = inn or dict(vx=0, vy=0, v=0, zoom=0)
    # components
    pan_mo, pan_mi = o["v"] >= pan_thr, i["v"] >= pan_thr
    z_mo, z_mi = abs(o["zoom"]) >= zoom_thr, abs(i["zoom"]) >= zoom_thr
    dir_cos = None
    if pan_mo and pan_mi:
        dir_cos = round((o["vx"] * i["vx"] + o["vy"] * i["vy"]) / (o["v"] * i["v"]), 3)
    zss = (z_mo and z_mi and o["zoom"] * i["zoom"] > 0) if (z_mo and z_mi) else None
    lo, hi = F - TH["stop_win"], F + TH["stop_win"]
    sp = {c: series(rows, lo, hi, c) for c in ("pan", "zoom")}
    thr = {"pan": pan_thr, "zoom": zoom_thr}
    # primary component: one that moves on both sides (the larger normalised side mean), else the larger normalised
    # speed over the seam's ±12 rows
    carried = {"pan": min(o["v"], i["v"]) / pan_thr if pan_mo and pan_mi else 0,
               "zoom": min(abs(o["zoom"]), abs(i["zoom"])) / zoom_thr if z_mo and z_mi else 0}
    norm = {c: max([v for v in sp[c].values() if v is not None] or [0]) / thr[c] for c in sp}
    if max(carried.values()) > 0: comp = max(carried, key=carried.get)
    else: comp = max(norm, key=norm.get) if max(norm.values()) >= 1 else None
    peaks = {c: peak_of(sp[c], F, thr[c]) for c in sp}
    # ratio on the primary component
    ratio = None
    if comp == "pan":
        ratio = (i["v"] / o["v"]) if o["v"] > 1e-6 else (99.0 if i["v"] >= pan_thr else None)
    elif comp == "zoom":
        if abs(o["zoom"]) > 1e-6: ratio = i["zoom"] / o["zoom"]
        elif abs(i["zoom"]) >= zoom_thr: ratio = 99.0
    if comp == "pan" and o["v"] < pan_thr and i["v"] < pan_thr: ratio = None          # 0 / 0: no speed to compare
    if comp == "zoom" and abs(o["zoom"]) < zoom_thr and abs(i["zoom"]) < zoom_thr: ratio = None
    ratio = None if ratio is None else round(ratio, 3)
    # stop-start (primary component)
    stop = None
    if comp:
        s_ = sp[comp]
        outs = [s_[f] for f in range(F - TH["stop_win"], F) if s_.get(f) is not None and f not in cut_rows]
        ins = [s_[f] for f in range(F, F + TH["stop_win"] + 1) if s_.get(f) is not None and f not in cut_rows]
        last_out = next((s_[f] for f in range(F - 1, F - TH["stop_win"] - 1, -1) if valid(rows[f]) if 0 < f < len(rows)), None)
        first_in = next((s_[f] for f in range(F, F + TH["stop_win"] + 1) if 0 < f < len(rows) and valid(rows[f])), None)
        so = bool(outs and max(outs) >= thr[comp] and last_out is not None and last_out < TH["stop_frac"] * max(outs))
        si = bool(ins and max(ins) >= thr[comp] and first_in is not None and first_in < TH["stop_frac"] * max(ins))
        stop = dict(out=so, **{"in": si}, last_out=None if last_out is None else round(last_out, 3),
                    first_in=None if first_in is None else round(first_in, 3),
                    out_peak=round(max(outs), 3) if outs else None, in_peak=round(max(ins), 3) if ins else None)
    stop_start = bool(stop and (stop["out"] or stop["in"]))
    # still sides
    def still(fs):
        rs = [rows[f] for f in fs if 0 < f < len(rows) and valid(rows[f])]
        return bool(rs) and all(math.hypot(r["vx"], r["vy"]) < TH["still_pan"] * px and abs(r["zoom"]) < TH["still_zoom"] for r in rs)
    st_out = still(range(F - TH["still_n"], F)); st_in = still(range(F, F + TH["still_n"]))
    still_side = "both" if st_out and st_in else "out" if st_out else "in" if st_in else None
    # luma / too sharp
    l0 = rows[F - 1]["luma"] if F - 1 >= 0 else None; l1 = rows[F]["luma"] if F < len(rows) else None
    luma_jump = round(abs(l1 - l0), 1) if l0 is not None and l1 is not None else None
    too_sharp = bool(hard and still_side and luma_jump is not None and (luma_jump >= TH["luma_jump"] or l1 < TH["black"]))
    holds, static = holds_near(rows, F, cut_rows)
    anc = None
    if F in anchors: anc = anchor_match(frames, F, anchors[F], W, H)
    speeds = []
    for f in range(F - 12, F + 13):
        if 0 < f < len(rows):
            r = rows[f]
            speeds.append(dict(f=f, film_f=f + offset, vx=r.get("vx"), vy=r.get("vy"),
                               v=None if r.get("vx") is None else round(math.hypot(r["vx"], r["vy"]), 3),
                               zoom=r.get("zoom"), rot=r.get("rot"), n=r.get("n"), method=r.get("method"),
                               cut=bool(r.get("cut")), mad=r.get("mad")))
    rec.update(component=comp, dir_cos=dir_cos, zoom_same_sign=zss, ratio=ratio,
               peak_offset=peaks.get(comp) if comp else None, peak_offsets=peaks, stop_start=stop_start, stop=stop,
               still_side=still_side, luma=[l0, l1], luma_jump=luma_jump, too_sharp=too_sharp, holds=holds,
               static_rows=static, anchor=anc, speeds=speeds,
               moving=dict(pan_out=pan_mo, pan_in=pan_mi, zoom_out=z_mo, zoom_in=z_mi))
    # direction kept: a component that moves on both sides keeps its way (pan cos ≥ 0.7, zoom same sign)
    kept = []
    if dir_cos is not None and dir_cos >= TH["dir_pass"]: kept.append("pan")
    if zss: kept.append("zoom")
    rev = []
    if dir_cos is not None and dir_cos < TH["dir_warn"]: rev.append("pan")
    if zss is False: rev.append("zoom")
    rec.update(direction_kept=kept, direction_reversed=rev)
    verdict(rec)
    return rec


def verdict(r):
    comp = r["component"]; fails, warns, fixes = [], [], []
    ratio, peak = r["ratio"], r["peak_offset"]
    band = TH["pan_ratio"] if comp == "pan" else TH["zoom_ratio"]
    dissolve = r["source"] == "transition" and r["still_side"] is None and comp is not None
    if r["holds"]:
        fails.append(f"holds at f{','.join(map(str, r['holds']))}"); fixes.append("remove the hold (a frozen / duplicated frame)")
    if r["too_sharp"]:
        fails.append(f"too_sharp (hard cut, luma jump {r['luma_jump']}, still {r['still_side']})")
        fixes.append("seam_fit %s on the still side, or carry a card off while the next scene dissolves in" % ("land" if r["still_side"] in ("in", "both") else "exit"))
    if r["stop_start"]:
        st = r["stop"]
        fails.append("stop_start (%s)" % ", ".join(
            ([f"out eases to {st['last_out']} of peak {st['out_peak']}"] if st["out"] else []) +
            ([f"in starts at {st['first_in']} of peak {st['in_peak']}"] if st["in"] else [])))
        fixes.append("seam_fit match" + (" --out ITEM:TRACK (accelerating end)" if st["out"] else "") +
                     (" --in ITEM:TRACK --ratio 1.2 (start moving)" if st["in"] else ""))
    comp_rev = comp in r["direction_reversed"] if comp else False
    if comp_rev:
        fails.append("reversed direction (%s)" % (f"dir_cos {r['dir_cos']}" if comp == "pan" else "zoom sign flips"))
        fixes.append("a different SR type (seam-grammar.md), or turn one side's move round")
    elif comp == "pan" and r["dir_cos"] is not None and r["dir_cos"] < TH["dir_pass"]:
        warns.append(f"dir_cos {r['dir_cos']}")
    if ratio is not None and comp and not dissolve:
        lo, hi = TH["ratio_warn"]
        if ratio < lo or ratio > hi:
            if r["still_side"] == "in" or (ratio < lo and r["still_side"] != "out"):
                fails.append(f"ratio {ratio} (in side %s)" % ("still" if r["still_side"] == "in" else "too slow"))
                fixes.append("seam_fit land --in ITEM:TRACK --from-seams" if r["still_side"] == "in" else "seam_fit match --in ITEM:TRACK --ratio 1.2")
            else:
                fails.append(f"ratio {ratio} (out side %s)" % ("still" if r["still_side"] == "out" else "too slow"))
                fixes.append("seam_fit exit --out ITEM:TRACK --from-seams" if r["still_side"] == "out" else "seam_fit match --out ITEM:TRACK")
        elif not (band[0] <= ratio <= band[1]):
            warns.append(f"ratio {ratio} (band {band[0]}–{band[1]})"); fixes.append("seam_fit match --ratio")
    if comp and not dissolve:
        if peak is None:
            pass
        elif abs(peak) > TH["peak_warn"] and not r["stop_start"]:
            fails.append(f"peak {peak:+d} f from the cut"); fixes.append("seam_fit match --out ITEM:TRACK (accelerate into the cut)")
        elif abs(peak) > TH["peak_pass"] and not r["stop_start"]:
            warns.append(f"peak {peak:+d} f"); fixes.append("seam_fit match")
    anc = r["anchor"]
    if anc is not None and not anc["ok"]:
        fails.append(f"anchor jumps ({anc['centre_dx']} px, ×{anc['scale']})"); fixes.append("keep the anchor's centre (≤ 30 px) and size (×0.95–1.3)")
    if comp is None and not (anc and anc["ok"]):
        warns.append("no move on either side"); fixes.append("give a side a drift (log-zoom ≥ 0.15 %/f), an anchor or a dissolve")
    v = "FAIL" if fails else "WARN" if warns else "PASS"
    if v == "PASS" and dissolve: r["note"] = "dissolve between two moving sides"
    if v == "PASS" and anc and anc["ok"]: r["note"] = "anchored seam"
    seen = []
    for x in fixes:
        if x not in seen: seen.append(x)
    r.update(verdict=v, fails=fails, warns=warns, fix="; ".join(seen) if v != "PASS" else "")


# ── report ────────────────────────────────────────────────────────────────────────────────────────────────────────
def fmt_side(s, comp):
    if not s: return "—"
    if comp == "zoom": return f"{s['zoom']:+.2f}%/f"
    return f"({s['vx']:+.1f},{s['vy']:+.1f}) {s['v']:.1f}px/f"


def type_guess(r):
    cut = "cut" if r["hard_cut"] else ("dissolve" if r["source"] == "transition" else "soft")
    c = r["component"]
    if c is None: mv = "still"
    elif c == "zoom":
        z = (r["out"] or {}).get("zoom", 0) + (r["in"] or {}).get("zoom", 0)
        mv = "zoom " + ("in" if z > 0.05 else "out" if z < -0.05 else "(stop at the seam)")
    else:
        o, i = r["out"] or {}, r["in"] or {}
        vx, vy = o.get("vx", 0) + i.get("vx", 0), o.get("vy", 0) + i.get("vy", 0)
        mv = "pan " + ({0: "→", 1: "↓", 2: "←", 3: "↑"}[int(((math.degrees(math.atan2(vy, vx)) + 45) % 360) // 90)])
    if r["still_side"] in ("in", "out"): mv += f" (still {r['still_side']})"
    return f"{cut} · {mv}"


def write_md(path, res, meta):
    L = [f"# Seams — {os.path.basename(meta['render'])}", "",
         f"{meta['width']}×{meta['height']} · {meta['fps']:g} fps · {meta['frames']} frames · film offset {meta['film_offset']} · "
         f"seams {meta['seams_mode']}", "",
         "| seam | time | type guess | out → in | ratio | peak | dir | verdict | fix |", "|---|---|---|---|---|---|---|---|---|"]
    for r in res:
        c = r["component"]
        dirs = []
        if r["dir_cos"] is not None: dirs.append(f"cos {r['dir_cos']:+.2f}")
        if r["zoom_same_sign"] is not None: dirs.append("zoom " + ("same" if r["zoom_same_sign"] else "FLIP"))
        why = "; ".join(r["fails"] + r["warns"])
        L.append(f"| f{r['f']}" + (f" (film {r['film_f']})" if meta['film_offset'] else "") + f" | {r['t']:.2f} s | {type_guess(r)} | "
                 f"{fmt_side(r['out'], c)} → {fmt_side(r['in'], c)} | {'—' if r['ratio'] is None else '×%.2f' % r['ratio']} | "
                 f"{'—' if r['peak_offset'] is None else '%+d' % r['peak_offset']} | {', '.join(dirs) or '—'} | "
                 f"**{r['verdict']}**{(' — ' + why) if why else ''} | {r['fix'] or ''} |")
    s = meta["summary"]
    L += ["", f"**Summary:** {s['n']} seams · PASS {s['PASS']} · WARN {s['WARN']} · FAIL {s['FAIL']} · direction kept "
          f"{s['direction_kept']}/{s['n']} · peak within ±2 f {s['peak_within_2']}/{s['n']} (±3: {s['peak_within_3']}) · hard cuts {s['hard_cuts']}", "",
          "Units: pan px/f in render pixels (thresholds ×W/1920), zoom %/f. Row f = motion f−1 → f; out = rows F−3…F−1, "
          "in = rows F…F+2 without the cut pair. Sheets: `sheets/seam_FFFF.jpg` (F as 4 digits)."]
    open(path, "w").write("\n".join(L) + "\n")


def sheet(path, frames, r, W, H, rows):
    F = r["f"]; tw = 300; th = int(round(tw * H / W))
    tiles = []
    for f in range(F - 3, F + 4):
        im = frames.get(f)
        t = np.zeros((th, tw, 3), np.uint8) if im is None else cv2.resize(im, (tw, th), interpolation=cv2.INTER_AREA)
        row = rows[f] if 0 < f < len(rows) else None
        cx, cy = tw // 2, th // 2
        if row is not None and row.get("vx") is not None and not row.get("cut"):
            g = 10.0 * tw / W
            ex, ey = row["vx"] * g, row["vy"] * g
            n = math.hypot(ex, ey)
            if n > th * 0.45: ex, ey = ex * th * 0.45 / n, ey * th * 0.45 / n
            if n > 1.0:
                cv2.arrowedLine(t, (cx, cy), (int(cx + ex), int(cy + ey)), (0, 0, 0), 5, tipLength=0.3)
                cv2.arrowedLine(t, (cx, cy), (int(cx + ex), int(cy + ey)), (60, 255, 60), 2, tipLength=0.3)
            z = row["zoom"] or 0
            if abs(z) >= 0.05:
                ln = min(th * 0.35, 12 + abs(z) * 8); col = (255, 200, 40)
                for dx, dy in ((1, 1), (-1, 1), (1, -1), (-1, -1)):
                    a0 = (int(cx + dx * 18), int(cy + dy * 18)); a1 = (int(cx + dx * (18 + ln * 0.7)), int(cy + dy * (18 + ln * 0.7)))
                    cv2.arrowedLine(t, a0 if z > 0 else a1, a1 if z > 0 else a0, col, 2, tipLength=0.35)
            lab = f"{row['vx']:+.1f},{row['vy']:+.1f} z{z:+.2f}%"
        else:
            lab = "CUT" if row is not None and row.get("cut") else "—"
        cv2.rectangle(t, (0, th - 22), (tw, th), (0, 0, 0), -1)
        cv2.putText(t, f"f{f} {lab}", (5, th - 6), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 255), 1, cv2.LINE_AA)
        if f == F:
            cv2.rectangle(t, (1, 1), (tw - 2, th - 2), (40, 40, 255), 4)
        tiles.append(t)
        tiles.append(np.full((th, 4, 3), 30, np.uint8))
    strip = np.hstack(tiles[:-1])
    head = np.zeros((34, strip.shape[1], 3), np.uint8)
    col = {"PASS": (90, 220, 90), "WARN": (40, 200, 255), "FAIL": (60, 60, 255)}[r["verdict"]]
    txt = f"seam f{r['f']}  {type_guess(r)}  ratio {r['ratio']}  peak {r['peak_offset']}  {r['verdict']}  " + "; ".join(r["fails"] + r["warns"])
    cv2.putText(head, txt[:150], (8, 23), cv2.FONT_HERSHEY_SIMPLEX, 0.55, col, 1, cv2.LINE_AA)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    cv2.imwrite(path, np.vstack([head, strip]), [cv2.IMWRITE_JPEG_QUALITY, 88])


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("render")
    ap.add_argument("--project-json")
    ap.add_argument("--seams", default="auto", help="auto (default) or comma-separated render frames")
    ap.add_argument("--out", help="output folder (default: <render>_seams/)")
    ap.add_argument("--anchor", action="append", default=[], help="F:x,y,w,h (render px), repeatable")
    ap.add_argument("--mask", action="append", default=[], help="x,y,w,h (render px) to ignore, repeatable")
    ap.add_argument("--film-offset", type=int, default=0, help="film frame of render frame 0 (range renders)")
    ap.add_argument("--no-sheets", action="store_true")
    a = ap.parse_args()
    out = a.out or os.path.splitext(a.render)[0] + "_seams"
    os.makedirs(out, exist_ok=True)
    masks = [tuple(float(x) for x in m.split(",")) for m in a.mask]
    rows, fps, W, H, _ = scan(a.render, masks)
    n = len(rows)
    anchors = {}
    for s in a.anchor:
        f, box = s.split(":"); anchors[int(f)] = tuple(float(x) for x in box.split(","))
    if a.seams == "auto":
        cuts = auto_cuts(rows)
        extra = project_seams(a.project_json, fps, a.film_offset, n) if a.project_json else []
        seams = merge_seams(cuts, extra)
    else:
        fs = sorted(int(x) for x in a.seams.split(",") if x.strip())
        seams = []
        for f in fs:
            cr = [g for g in (f - 1, f, f + 1) if 0 < g < n and rows[g]["cut"]]   # the picture change at this seam
            seams.append(dict(f=f, source="given", cut_rows=cr))
        if a.project_json:
            byf = {s["f"]: s for s in project_seams(a.project_json, fps, a.film_offset, n)}
            for s in seams:
                m = next((byf[g] for g in range(s["f"] - 2, s["f"] + 3) if g in byf), None)
                if m: s.update(source=m["source"], what=m.get("what"), item=m.get("item"), transition=m.get("transition"))
    seams = [s for s in seams if 4 <= s["f"] <= n - 3]
    need = set()
    for s in seams: need.update(range(s["f"] - 3, s["f"] + 4))
    frames = grab(a.render, need) if (not a.no_sheets or anchors) else {}
    res = [measure(rows, s, W, H, fps, anchors, frames, a.film_offset) for s in seams]
    summ = dict(n=len(res), PASS=sum(r["verdict"] == "PASS" for r in res), WARN=sum(r["verdict"] == "WARN" for r in res),
                FAIL=sum(r["verdict"] == "FAIL" for r in res), direction_kept=sum(bool(r["direction_kept"]) for r in res),
                direction_reversed=sum(bool(r["direction_reversed"]) and not r["direction_kept"] for r in res),
                peak_within_2=sum(r["peak_offset"] is not None and abs(r["peak_offset"]) <= 2 for r in res),
                peak_within_3=sum(r["peak_offset"] is not None and abs(r["peak_offset"]) <= 3 for r in res),
                peak_any_within_2=sum(any(v is not None and abs(v) <= 2 for v in r["peak_offsets"].values()) for r in res),
                hard_cuts=sum(r["hard_cut"] for r in res), auto_cuts=len(auto_cuts(rows)))
    meta = dict(render=os.path.abspath(a.render), fps=fps, width=W, height=H, frames=n, film_offset=a.film_offset,
                seams_mode=a.seams if a.seams == "auto" else "given", project_json=a.project_json, masks=masks,
                px_scale=round(W / REF_W, 4), thresholds=TH, summary=summ,
                units=dict(pan="px/f (render px)", zoom="%/f", rot="deg/f", row="motion f-1 -> f"))
    json.dump(dict(meta, seams=res), open(os.path.join(out, "seams.json"), "w"), indent=1)
    write_md(os.path.join(out, "SEAMS.md"), res, meta)
    if not a.no_sheets:
        for r in res: sheet(os.path.join(out, "sheets", f"seam_{r['f']:04d}.jpg"), frames, r, W, H, rows)
    for r in res:
        print(f"f{r['f']:5d} {type_guess(r):28s} ratio {str(r['ratio']):>7s} peak {str(r['peak_offset']):>4s} "
              f"{r['verdict']:4s} {'; '.join(r['fails'] + r['warns'])}")
    print(json.dumps(summ))
    print("->", out)


if __name__ == "__main__":
    main()
