#!/usr/bin/env python3
"""seam_fit.py — MATCH VELOCITY at a seam of a GLEA (GreenLight Dash Video Editor) project. Spec: ../match-velocity.md;
GLEA usage: ../match-velocity.md ("In the Video Editor").

  seam_fit.py inspect --board B --project P --item ITEM [--track T] [--at-frame F]
      the item's keyed tracks: segments (film frames), easings, start/end slopes E'(0)/E'(1), start/end velocity in
      track units per frame; with --at-frame the value and velocity on every frame F−12…F+12. A layer on a live
      motion path also gets its screen position and speed (px/f) on those frames, from its motionPathT.

  seam_fit.py match --board B --project P --seams seams.json --seam F [--in ITEM:TRACK] [--out ITEM:TRACK]
                    [--ratio 1.2] [--out-slope 3] [--out-velocity V] [--soft-landing] [--dry-run]
      (at least one of --in / --out)
      reads seam F's measured out/in velocity (seam_check.py's seams.json) and rewrites the in track's first segment
      after the seam to a Custom bezier whose start gives ratio × the out speed, keeping its values, positions and its
      landing (end) handle; with --out it first rewrites the out track's last segment before the seam to an
      accelerating end (end slope --out-slope, or the out mean speed --out-velocity in screen units), keeping its far
      (start) handle when the curve stays monotone. Prints the before/after handles, slopes and the predicted speeds.
      --soft-landing: the in segment also ends at rest (end handle 0.5, 1). A segment that was Linear keeps a
      constant-speed end, so a layer that stays on after its last key stops dead there: the plan says so.

  seam_fit.py land --board B --project P --seam F --in ITEM:TRACK (--velocity V | --from-seams seams.json)
                   [--frames L] [--easing "Cubic Out"] [--ratio 1.2] [--dry-run]
  seam_fit.py exit --board B --project P --seam F --out ITEM:TRACK (--velocity V | --from-seams seams.json)
                   [--frames L] [--easing "Cubic In"] [--ratio 1.2] [--dry-run]
      a static side gets a short move: land = from base − Δ at the seam to base at seam + L, eased out; exit = from
      base at seam − L to base + Δ at the seam, eased in. V is in track units per frame (signed; zoom tracks: log units
      per frame); --from-seams takes it from the other side's measured velocity × ratio (land) or ÷ ratio (exit),
      converted with the item's scale. Δ is set so the seam's measured rows (as seam_check reads them) move at V.

ITEM is an item id; items inside sequences are SEQ_ITEM/ITEM (the path of item ids; a bare inner id is found too);
camera:TRACK is the camera clip covering the seam (SEQ_ITEM/camera:TRACK for a sequence's own camera). A layer that
rides a motion path is matched on ITEM:motionPathT, its progress track: the path keeps its shape and the speed along
it changes (its axis and px per % are read from the path at the seam). F is a FILM
frame (the first frame of the incoming shot). Board and project: --board/--project (or $SEAM_BOARD/$SEAM_PROJECT;
the older $VRX_BOARD/$VRX_PROJECT still work). --fps (default 30) is the project's frame rate; --work (default the
current folder) holds the logs. All writes go through tools/lib/vp.py (GET → change computed on that fresh data →
PUT expected_version, a 409 reruns the change on the new version), log to <work>/seam_fit_log.jsonl, keep every other
field. --dry-run prints the patch and writes nothing. Then render the seam's range
(lib/vp.py --board B --project P render F−20 F+20 out.mp4) and run seam_check.py out.mp4 --seams 20 --film-offset F−20.
A camera under Smart Zoom, a Camera Rig or a live camera path ignores its camX/camY/camZoom keys (rig and path also
camDolly, tilt and roll): set the camera item's "cameraMoveMode": "free" before writing camera:TRACK, or key the items.
"""
import argparse, copy, json, math, os, sys, time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "lib"))
import easing  # noqa: E402  (loads lib/editor_easings.json)
import kitlib  # noqa: E402
import keyfit  # noqa: E402
import timeline  # noqa: E402
import vp  # noqa: E402

FPS = 30.0
AXIS = {"translateX": "vx", "xPercent": "vx", "motionPathOffsetX": "vx", "camX": "vx",
        "translateY": "vy", "yPercent": "vy", "motionPathOffsetY": "vy", "camY": "vy",
        "scale": "zoom", "scaleX": "zoom", "scaleY": "zoom", "camZoom": "zoom", "translateZ": "zoom", "camDolly": "zoom",
        "rotate": "rot", "camRoll": "rot"}
PATH_T = "motionPathT"                                           # progress 0–100 along the item's motionPath
RATIO_TRACKS = ("scale", "scaleX", "scaleY", "camZoom")          # zoom = d ln(value)
DEFAULT_VALUE = {"scale": 1.0, "scaleX": 1.0, "scaleY": 1.0, "camZoom": 1.0}
LINEAR_BZ = [1 / 3, 1 / 3, 2 / 3, 2 / 3]


# ── easing of one segment ─────────────────────────────────────────────────────────────────────────────────────────
def _bz_ok(k):
    return isinstance(k.get("bezier"), list) and len(k["bezier"]) == 4


def _base_ease(k, u):
    e = k.get("easing") or "Linear"
    if e == "Linear": return u
    if e == "Hold": return 0.0 if u < 1 else 1.0
    if e == "Custom":
        return float(keyfit.bez_ease(u, *k["bezier"])) if _bz_ok(k) else easing.ease("Smooth", u)
    return easing.ease(e, u)


def ease_u(k, u):
    """progress 0…1 of the segment that STARTS at key k (its easing, Custom bezier, or the easeSlice part of it)"""
    sl = k.get("easeSlice")
    if isinstance(sl, dict) and sl.get("of") == (k.get("easing") or "Linear") and \
            (k.get("easing") != "Custom" or sl.get("bezier") in (None, k.get("bezier"))):
        a, b = float(sl.get("from", 0)), float(sl.get("to", 1))
        ea, eb = _base_ease(k, a), _base_ease(k, b)
        if abs(eb - ea) < 1e-12: return u
        return (_base_ease(k, a + u * (b - a)) - ea) / (eb - ea)
    return _base_ease(k, u)


def bezier_of(k):
    """the segment's curve as [x1, y1, x2, y2] (a named easing: the editor's catalogue bezier, approximate for
    sampled curves)"""
    e = k.get("easing") or "Linear"
    if e == "Custom" and _bz_ok(k): return [float(x) for x in k["bezier"]], False
    if e == "Linear": return list(LINEAR_BZ), False
    c = easing.CURVES.get(e)
    if c and c.get("cubicBezier"): return [float(x) for x in c["cubicBezier"]], bool(c.get("bezierIsApproximate"))
    return None, False


def slopes(k):
    """E'(0), E'(1) of the segment starting at k, numerically (1 % of the segment)"""
    d = 0.01
    return (ease_u(k, d) - ease_u(k, 0)) / d, (ease_u(k, 1) - ease_u(k, 1 - d)) / d


def monotone(bz):
    x1, y1, x2, y2 = bz
    t = np.linspace(0, 1, 201)
    dy = 3 * (1 - t) ** 2 * y1 + 6 * (1 - t) * t * (y2 - y1) + 3 * t ** 2 * (1 - y2)
    return bool((dy >= -1e-9).all())


def speed_profile(bz, n=201):
    """the curve's slope dy/dx along it (E'(u) over the segment)"""
    x1, y1, x2, y2 = bz
    t = np.linspace(0, 1, n)
    dx = 3 * (1 - t) ** 2 * x1 + 6 * (1 - t) * t * (x2 - x1) + 3 * t ** 2 * (1 - x2)
    dy = 3 * (1 - t) ** 2 * y1 + 6 * (1 - t) * t * (y2 - y1) + 3 * t ** 2 * (1 - y2)
    return dy / np.maximum(dx, 1e-9)


def dip(bz):
    """True when the speed falls in the middle below half of both ends' speed (fast-slow-fast)"""
    v = speed_profile(bz)
    ends = min(v[0], v[-1])
    return bool(ends > 0.5 and v[30:171].min() < 0.5 * ends)


def with_start_slope(bz, S):
    """the start handle set to slope S (E'(0) = y1/x1), the end (landing) handle kept; no overshoot past the end
    value (y1 ≤ 1: a steeper start shortens the handle instead), monotone (y2 raised to y1 if needed)"""
    x1, y1, x2, y2 = bz; notes = []
    h = x1 if x1 > 0.02 else 1 / 3
    if S * h > 1: h = 1.0 / S; notes.append("start handle shortened to x1=%.3f to keep y1 ≤ 1 (no overshoot)" % h)
    nb = [h, S * h, x2, y2]
    if not monotone(nb):
        nb[3] = max(y2, nb[1]); notes.append("end handle raised to y2=%.3f to keep the move monotone" % nb[3])
    return [round(v, 4) for v in nb], notes


LANDING = (0.5, 1.0)        # the end handle of a move that comes to rest (--soft-landing)


def with_end_slope(bz, S):
    """the end handle set to slope S (E'(1) = (1−y2)/(1−x2)), the start (far) handle kept when the curve stays
    monotone, else lowered"""
    x1, y1, x2, y2 = bz; notes = []
    h = (1 - x2) if (1 - x2) > 0.02 else 1 / 3
    if S * h > 1: h = 1.0 / S; notes.append("end handle shortened to 1−x2=%.3f to keep y2 ≥ 0" % h)
    nb = [x1, y1, 1 - h, 1 - S * h]
    if not monotone(nb):
        nb[1] = min(y1, nb[3]); notes.append("start handle lowered to y1=%.3f (the old fast start would reverse the move)" % nb[1])
    if dip(nb):        # a fast start kept in front of a fast end stalls mid-segment: a stutter inside the shot
        nb[1] = round(min(nb[1], nb[0] * 1.0), 4)
        notes.append("start handle softened to slope 1 (the old fast start made the move stall mid-segment)")
    return [round(v, 4) for v in nb], notes


# ── a layer on a motion path ──────────────────────────────────────────────────────────────────────────────────────
def path_live(item):
    mp = item.get("motionPath") or {}
    return mp if mp.get("follow") is True and len(mp.get("points") or []) >= 2 else None


def path_point(mp, progress):
    """the path's point at progress 0…100, as the editor samples it: the progress picks a segment and its bezier
    parameter (equal shares per segment, not distance), handles are offsets from their anchors. World px, y up."""
    pts = mp["points"]; closed = mp.get("closed") is True
    segs = len(pts) if closed else len(pts) - 1
    u = (progress / 100.0) % 1.0 if closed else min(1.0, max(0.0, progress / 100.0))
    i = min(segs - 1, int(math.floor(u * segs))); t = u * segs - i
    a, b = pts[i], pts[(i + 1) % len(pts)]
    out = []
    for ax in ("x", "y", "z"):
        p0 = float(a.get(ax) or 0); p3 = float(b.get(ax) or 0)
        p1 = p0 + float((a.get("hOut") or {}).get(ax) or 0); p2 = p3 + float((b.get("hIn") or {}).get(ax) or 0)
        out.append((1 - t) ** 3 * p0 + 3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t * t * p2 + t ** 3 * p3)
    return out


def path_screen(ref, progress):
    """where the layer's centre is drawn (project px, y down) at this progress: the pinhole of world-rig-films.md"""
    mp = path_live(ref.item)
    w, h = float(ref.video.get("w", 1920)), float(ref.video.get("h", 1080))
    x, y, z = path_point(mp, progress); z += float(ref.item.get("motionPathOffsetZ") or 0)
    P = (h / 2.0) / math.tan(math.radians(14.0)); sc = P / (P - z) if P - z > 1e-6 else 1.0
    return (w / 2 + (x + float(ref.item.get("motionPathOffsetX") or 0)) * sc,
            h / 2 + (-y + float(ref.item.get("motionPathOffsetY") or 0)) * sc)


def path_progress(ref, f):
    keys = ref.keys(PATH_T)
    return value_at(keys, ref.pos(f)) if keys else float(ref.item.get(PATH_T) or 0)


def path_k(ref, f):
    """(axis, project px per 1 % of progress) at film frame f: the axis the path mostly runs along there"""
    if not path_live(ref.item):
        raise SystemExit(f"{ref.path}: no live motion path (motionPath with follow: true and two or more points), so "
                         f"{PATH_T} moves nothing")
    if (ref.item.get("propertyKeyframes") or {}).get("motionPathPoints"):
        print(f"WARNING: {ref.path}: the path itself is keyed (motionPathPoints); the speed is read from the stored "
              "path, which the keys may have moved", file=sys.stderr)
    T = path_progress(ref, f); d = 0.05
    closed = path_live(ref.item).get("closed") is True
    lo, hi = (T - d, T + d) if closed else (max(0.0, T - d), min(100.0, T + d))
    if hi - lo < 1e-9: lo, hi = max(0.0, T - 2 * d), min(100.0, T + 2 * d)
    (x0, y0), (x1, y1) = path_screen(ref, lo), path_screen(ref, hi)
    dx, dy = (x1 - x0) / (hi - lo), (y1 - y0) / (hi - lo)
    return ("vx", dx) if abs(dx) >= abs(dy) else ("vy", dy)


def axis_of(ref, track, f):
    """the measured axis a track moves (seam_check's vx / vy / zoom / rot); a path's progress: where it runs at f"""
    return path_k(ref, f)[0] if track == PATH_T else AXIS.get(track)


# ── tracks ────────────────────────────────────────────────────────────────────────────────────────────────────────
def sorted_keys(keys):
    return sorted(keys, key=lambda k: float(k["position"]))


def value_at(keys, pos):
    ks = sorted_keys(keys)
    if pos <= float(ks[0]["position"]): return float(ks[0]["value"])
    for a, b in zip(ks, ks[1:]):
        pa, pb = float(a["position"]), float(b["position"])
        if pos <= pb:
            u = (pos - pa) / max(1e-9, pb - pa)
            return float(a["value"]) + (float(b["value"]) - float(a["value"])) * ease_u(a, u)
    return float(ks[-1]["value"])


def seg_index(keys, pos, side):
    """index of the segment [k_i, k_i+1] right after pos (side 'in') or right before it (side 'out')"""
    ks = sorted_keys(keys)
    for i in range(len(ks) - 1):
        pa, pb = float(ks[i]["position"]), float(ks[i + 1]["position"])
        if (side == "in" and pa - 1e-6 <= pos < pb - 1e-6) or (side == "out" and pa + 1e-6 < pos <= pb + 1e-6):
            return i
    return None


class Ref:
    """an item (or a camera clip) on the film timeline: film frame of its start, its played length in film frames,
    the zoom of the sequences around it"""
    def __init__(self, path, item, start_f, n_f, chain_zoom, camera, video):
        self.path, self.item, self.start_f, self.n_f, self.chain_zoom, self.camera, self.video = \
            path, item, start_f, n_f, chain_zoom, camera, video

    def pos(self, f): return (f - self.start_f) / self.n_f * 100.0

    def first(self): return math.ceil(self.start_f - 1e-6)                    # first film frame it shows

    def last(self): return math.ceil(self.start_f + self.n_f - 1e-6) - 1      # last film frame it shows

    def frame(self, p): return self.start_f + p / 100.0 * self.n_f

    def keys(self, track): return (self.item.get("propertyKeyframes") or {}).get(track)


def find_path(d, iid, prefix=""):
    for ch in d.get("channels", []):
        for it in ch.get("items", []):
            if it.get("id") == iid: return prefix + iid
    cm = timeline.clips(d)
    for ch in d.get("channels", []):
        for it in ch.get("items", []):
            c = cm.get(it.get("clipId"), {})
            if c.get("mediaType") == "sequence" and isinstance(c.get("sequence"), dict):
                p = find_path(c["sequence"], iid, prefix + it["id"] + "/")
                if p: return p
    return None


def resolve(d, path, at_f, fps=FPS):
    """Ref for 'ITEM', 'SEQ/ITEM', 'camera' or 'SEQ/camera' in data d (fresh). at_f: the film frame the camera clip
    must cover."""
    parts = path.split("/")
    if len(parts) == 1 and parts[0] != "camera":
        fp = find_path(d, parts[0])                    # a bare id inside a sequence: its full path
        if fp: parts = fp.split("/")
    tl, off, sc, chain = d, 0.0, 1.0, 1.0              # film_s = off + sc * local_s
    vs = d.get("videoSize") or {"w": 1920, "h": 1080}
    for i, p in enumerate(parts):
        lay = timeline.layout(tl.get("channels", []), timeline.clips(tl))
        if p == "camera":
            t_local = (at_f / fps - off) / sc
            hit = [x for x in lay if (x[0].get("kind") == "camera" or x[4].get("mediaType") == "camera")
                   and x[2] - 1e-6 <= t_local < x[3] - 1e-6]
            if not hit: raise SystemExit(f"no camera clip covers film frame {at_f} in {'/'.join(parts[:i]) or 'the project'}")
        else:
            hit = [x for x in lay if x[1].get("id") == p]
            if not hit: raise SystemExit(f"item {p!r} not found in {'/'.join(parts[:i]) or 'the project'}")
        ch, it, a, b, clip, _ = hit[0]
        ref = Ref("/".join(parts[:i + 1]), it, (off + sc * a) * fps, sc * (b - a) * fps, chain, p == "camera", vs)
        if i == len(parts) - 1: return ref
        if clip.get("mediaType") != "sequence": raise SystemExit(f"{p!r} is not a sequence item")
        z = float(it.get("zoom") or 1)                 # the sequence scales what it holds: its zoom × its scale key
        sk = (it.get("propertyKeyframes") or {}).get("scale")
        if sk: z *= value_at(sk, ref.pos(at_f))
        chain *= z
        sp, ts = timeline.speed(it), float(it.get("trimStart") or 0)
        off, sc = off + sc * (a - ts / sp), sc / sp
        tl = clip["sequence"]
    raise SystemExit("empty path")


def rows_pred(keys, ref, track, frames):
    """predicted per-row change of the track (row f = frame f−1 → f), track units; zoom tracks in %/f"""
    out = []
    for f in frames:
        v0, v1 = value_at(keys, ref.pos(f - 1)), value_at(keys, ref.pos(f))
        out.append((v1 / v0 - 1) * 100 if track in RATIO_TRACKS and v0 else v1 - v0)
    return out


def rows_screen(keys, ref, track, frames, k, at_f):
    """the track's per-row change in screen units: k × the track's own rows; a path's progress is walked along the
    path itself (its px per % changes along the curve; k holds at film frame at_f)"""
    if track != PATH_T: return [k * r for r in rows_pred(keys, ref, track, frames)]
    axis, k0 = path_k(ref, at_f); i = 0 if axis == "vx" else 1
    c = k / k0 if abs(k0) > 1e-9 else 0.0
    return [c * (path_screen(ref, value_at(keys, ref.pos(f)))[i] - path_screen(ref, value_at(keys, ref.pos(f - 1)))[i]) for f in frames]


def k_units(track, ref, meta, keys_at=None, at_f=None):
    """screen units (render px/f, %/f, °/f) per track unit per frame, from the units alone"""
    pw, ph = float(ref.video.get("w", 1920)), float(ref.video.get("h", 1080))
    rw, rh = float(meta.get("width") or pw), float(meta.get("height") or ph)
    z = ref.chain_zoom
    if track == PATH_T:
        axis, k = path_k(ref, at_f if at_f is not None else ref.first())
        return k * (rw / pw if axis == "vx" else rh / ph) * z
    if track in ("translateX", "motionPathOffsetX"): return rw / pw * z
    if track in ("translateY", "motionPathOffsetY"): return rh / ph * z
    if track == "xPercent": return rw / 100 * z
    if track == "yPercent": return rh / 100 * z
    if track == "camX": return -rw / 100 * (keys_at or 1.0)
    if track == "camY": return -rh / 100 * (keys_at or 1.0)
    if track in RATIO_TRACKS or track == "rotate": return 1.0
    if track == "camRoll": return -1.0
    return None


def measured(seam, axis):
    """{film frame: measured axis value} of seam_check's per-frame rows (valid rows only)"""
    m = {}
    for r in seam.get("speeds", []):
        if r.get("cut") or r.get(axis) is None: continue
        m[int(r["film_f"])] = float(r[axis])
    return m


def estimate_k(keys, ref, track, seam, axis):
    """k from the measurement: the track's predicted rows vs the measured rows where the track moves"""
    m = measured(seam, axis)
    fs = [f for f in sorted(m) if ref.first() + 1 <= f <= ref.last()]
    if len(fs) < 3: return None, "too few measured rows on the item"
    rt = np.array(rows_pred(keys, ref, track, fs)); mm = np.array([m[f] for f in fs])
    big = np.abs(rt) >= 0.2 * max(1e-9, np.abs(rt).max())
    if np.abs(rt).max() < 1e-6 or big.sum() < 3: return None, "the track hardly moves on the measured rows"
    rt, mm = rt[big], mm[big]
    k = float((mm * rt).sum() / (rt * rt).sum())
    res = mm - k * rt
    if np.sqrt((res ** 2).mean()) > 0.35 * max(1e-9, np.sqrt((mm ** 2).mean())):
        return None, "the measured motion does not follow this track (k fit residual %.0f %%)" % (
            100 * np.sqrt((res ** 2).mean()) / max(1e-9, np.sqrt((mm ** 2).mean())))
    return k, "measured on %d rows" % len(rt)


def pick_k(keys, ref, track, seam, axis, meta, at_f=None):
    ku = k_units(track, ref, meta, at_f=at_f)
    if keys and seam is not None:
        km, why = estimate_k(keys, ref, track, seam, axis)
        if km is not None:
            return km, f"k {km:.4g} ({why}; units say {ku if ku is None else round(ku, 4)})"
    if ku is None: raise SystemExit(f"cannot convert {track} to screen units: pass --velocity in track units")
    return ku, f"k {ku:.4g} (from the units)"


# ── seams.json ────────────────────────────────────────────────────────────────────────────────────────────────────
def load_seam(path, F):
    j = json.load(open(path))
    best = min(j["seams"], key=lambda s: abs(s["film_f"] - F)) if j.get("seams") else None
    if best is None or abs(best["film_f"] - F) > 2:
        raise SystemExit(f"seam {F} not in {path} (film frames there: {[s['film_f'] for s in j.get('seams', [])]})")
    return best, j


def side_rows(seam, side, ref):
    """the film rows seam_check averages for this side, limited to rows whose two frames are both on the item"""
    off = seam["film_f"] - seam["f"]
    v = seam.get(side) or {}
    rows = [r + off for r in (v.get("rows") or [])]
    F = seam["film_f"]
    if not rows:
        rows = [F - 3, F - 2, F - 1] if side == "out" else ([F + 1, F + 2] if seam.get("hard_cut") else [F, F + 1, F + 2])
    return [f for f in rows if ref.first() + 1 <= f <= ref.last()] or rows


def seam_mean(seam, side, axis):
    v = seam.get(side) or {}
    return float(v.get(axis) or 0.0)


# ── the change functions (run on FRESH data inside vp.patch; they may run again after a 409) ────────────────────
def split_spec(s):
    if ":" not in s: raise SystemExit(f"{s!r}: expected ITEM:TRACK")
    p, t = s.split(":", 1)
    if p.endswith("/camera") or p == "camera": return p, t
    return p, t


# camera modes that overwrite pose keys (camera.md: the keys stay stored but render as nothing)
CAM_OVERRIDES = {   # cameraMoveMode: (tracks it always overwrites, tracks it may overwrite)
    "smartZoom": (("camZoom", "camX", "camY"), ()),
    "rig": (("camX", "camY", "camDolly"), ("camTiltX", "camTiltY", "camRoll")),
    "path": ((), ("camX", "camY", "camDolly", "camTiltX", "camTiltY", "camRoll")),
}


def camera_mode(ref):
    return (ref.item.get("cameraMoveMode") or "free") if ref.camera else None


def check_camera(ref, track):
    """refuse to key a camera track the camera's mode overwrites (Smart Zoom, Rig); warn for a path or an aimed rig"""
    mode = camera_mode(ref)
    if not mode: return
    always, maybe = CAM_OVERRIDES.get(mode, ((), ()))
    msg = (f"{ref.path}:{track}: the camera's cameraMoveMode is {mode!r}, which %s its {track} keys (stored, but they "
           "render as nothing: camera.md). Set the camera item's cameraMoveMode to \"free\" first, or key the items.")
    if track in always: raise SystemExit(msg % "overwrites")
    if track in maybe: print("WARNING: " + msg % "may overwrite (a live path, an aimed rig)", file=sys.stderr)


def solve_slope(make, target, lo=0.0, hi=60.0):
    """the slope S whose curve gives |predicted mean| = |target| (bisection; the mean grows with S)"""
    f_lo, f_hi = abs(make(lo)), abs(make(hi))
    if abs(target) >= f_hi: return hi, True
    if abs(target) <= f_lo: return lo, True
    for _ in range(60):
        m = (lo + hi) / 2
        if abs(make(m)) < abs(target): lo = m
        else: hi = m
    return (lo + hi) / 2, False


def plan_match(d, a, seam, meta):
    F = seam["film_f"]; rep = dict(cmd="match", seam=F, changes=[], notes=[])
    out_ref = out_track = None
    axis = None
    if a.out:
        op, out_track = split_spec(a.out); out_ref = resolve(d, op, F - 1); check_camera(out_ref, out_track)
        axis = axis_of(out_ref, out_track, F - 1)
    if a.inn:
        ip, in_track = split_spec(a.inn); in_ref = resolve(d, ip, F); check_camera(in_ref, in_track)
        in_axis = axis_of(in_ref, in_track, F)
        if axis and in_axis != axis: raise SystemExit(f"--out {out_track} and --in {in_track} move different axes")
        axis = in_axis
    if axis is None: raise SystemExit("unknown track (supported: %s, %s)" % (", ".join(AXIS), PATH_T))
    mo, mi = seam_mean(seam, "out", axis), seam_mean(seam, "in", axis)
    rep["measured"] = dict(axis=axis, out=mo, **{"in": mi}, ratio=seam.get("ratio"), peak=seam.get("peak_offset"))
    pred_out = mo
    # 1. the out side's last segment -> an accelerating end
    if a.out:
        keys = out_ref.keys(out_track)
        if not keys or len(keys) < 2: raise SystemExit(f"{a.out}: no keyed segment before the seam (a static side: use exit)")
        ks = sorted_keys(keys); i = seg_index(ks, min(100.0, out_ref.pos(F)), "out")
        if i is None: raise SystemExit(f"{a.out}: no segment ends at/after the seam (keys at {[k['position'] for k in ks]})")
        k0 = ks[i]; bz, approx = bezier_of(k0)
        if bz is None: raise SystemExit(f"{a.out}: easing {k0.get('easing')!r} has no curve to reshape")
        kq, kwhy = pick_k(keys, out_ref, out_track, seam, axis, meta, F - 1)
        rows = side_rows(seam, "out", out_ref)
        def out_keys(S):
            nb, _ = with_end_slope(bz, S); ks2 = copy.deepcopy(ks); ks2[i].update(easing="Custom", bezier=nb); ks2[i].pop("easeSlice", None)
            return ks2
        mean_screen = lambda S: float(np.mean(rows_screen(out_keys(S), out_ref, out_track, rows, kq, F - 1)))
        if a.out_velocity is not None: S, clamp = solve_slope(mean_screen, a.out_velocity)
        elif a.inn is None and abs(mi) > 0: S, clamp = solve_slope(mean_screen, mi / a.ratio)
        else: S, clamp = a.out_slope, False
        nb, notes = with_end_slope(bz, S)
        s0, s1 = slopes(k0)
        new = out_keys(S); pred_out = mean_screen(S)
        rep["changes"].append(dict(path=out_ref.path, track=out_track, side="out", segment=[float(ks[i]["position"]), float(ks[i + 1]["position"])],
                                   frames=[round(out_ref.frame(float(ks[i]["position"])), 2), round(out_ref.frame(float(ks[i + 1]["position"])), 2)],
                                   before=dict(easing=k0.get("easing"), bezier=k0.get("bezier") or bz, approx=approx, E0=round(s0, 3), E1=round(s1, 3)),
                                   after=dict(easing="Custom", bezier=nb, E1=round(S, 3)), k=kwhy, rows=rows,
                                   predicted_mean=round(pred_out, 3), measured_mean=round(mo, 3), notes=notes + (["slope clamped"] if clamp else []),
                                   keys=new))
    # 2. the in side's first segment -> starts moving at ratio × the out speed
    if a.inn:
        keys = in_ref.keys(in_track)
        if not keys or len(keys) < 2: raise SystemExit(f"{a.inn}: no keyed segment after the seam (a static side: use land)")
        ks = sorted_keys(keys); i = seg_index(ks, max(0.0, in_ref.pos(F)), "in")
        if i is None: raise SystemExit(f"{a.inn}: no segment starts at/after the seam (keys at {[k['position'] for k in ks]})")
        k0 = ks[i]; bz, approx = bezier_of(k0)
        if bz is None: raise SystemExit(f"{a.inn}: easing {k0.get('easing')!r} has no curve to reshape")
        if abs(pred_out) < 1e-6: raise SystemExit("the out side does not move at the seam: add --out ITEM:TRACK (accelerating end) or use land")
        kq, kwhy = pick_k(keys, in_ref, in_track, seam, axis, meta, F)
        soft = bool(getattr(a, "soft_landing", False))
        if soft: bz = [bz[0], bz[1], LANDING[0], LANDING[1]]
        target = a.ratio * pred_out
        dv = float(ks[i + 1]["value"]) - float(k0["value"])
        if in_track in RATIO_TRACKS: dv = math.log(float(ks[i + 1]["value"]) / float(k0["value"]))
        if kq * dv * target < 0:
            raise SystemExit(f"the in segment moves against the out motion ({in_track} {k0['value']}→{ks[i + 1]['value']}, "
                             f"out {axis} {pred_out:+.3f}): a different seam type, or turn the move round")
        rows = side_rows(seam, "in", in_ref)
        def in_keys(S):
            nb, _ = with_start_slope(bz, S); ks2 = copy.deepcopy(ks); ks2[i].update(easing="Custom", bezier=nb); ks2[i].pop("easeSlice", None)
            return ks2
        mean_screen = lambda S: float(np.mean(rows_screen(in_keys(S), in_ref, in_track, rows, kq, F)))
        S, clamp = solve_slope(mean_screen, target)
        nb, notes = with_start_slope(bz, S)
        s0, s1 = slopes(k0)
        new = in_keys(S); pred_in = mean_screen(S)
        if clamp: notes.append("the needed start slope is beyond the curve's reach: shorten the segment (move its end key earlier) or raise its span")
        e1 = (1 - nb[3]) / max(1 - nb[2], 1e-6)
        if soft: notes.append("end handle set to (%g, %g): the move ends at rest" % LANDING)
        elif e1 > 0.25 and i + 1 == len(ks) - 1 and in_ref.frame(float(ks[i + 1]["position"])) < in_ref.last() - 0.5:
            notes.append("the move ends on film frame %g still at %.0f %% of its mean speed and the layer stays on screen: it stops "
                         "dead there. Add --soft-landing unless that stop is meant" % (round(in_ref.frame(float(ks[i + 1]["position"])), 1), e1 * 100))
        rep["changes"].append(dict(path=in_ref.path, track=in_track, side="in", segment=[float(ks[i]["position"]), float(ks[i + 1]["position"])],
                                   frames=[round(in_ref.frame(float(ks[i]["position"])), 2), round(in_ref.frame(float(ks[i + 1]["position"])), 2)],
                                   before=dict(easing=k0.get("easing"), bezier=k0.get("bezier") or bz, approx=approx, E0=round(s0, 3), E1=round(s1, 3)),
                                   after=dict(easing="Custom", bezier=nb, E0=round(S, 3)), k=kwhy, rows=rows,
                                   predicted_mean=round(pred_in, 3), measured_mean=round(mi, 3), target=round(target, 3), notes=notes,
                                   keys=new))
        rep["predicted"] = dict(out=round(pred_out, 3), **{"in": round(pred_in, 3)}, ratio=round(pred_in / pred_out, 3))
    else:
        rep["predicted"] = dict(out=round(pred_out, 3), **{"in": round(mi, 3)}, ratio=round(mi / pred_out, 3) if pred_out else None)
    return rep


def plan_static(d, a, seam, meta, kind):
    """land (in side) / exit (out side): a short eased move on a static side"""
    F = a.seam
    spec = a.inn if kind == "land" else a.out
    p, track = split_spec(spec)
    ref = resolve(d, p, F if kind == "land" else F - 1)
    check_camera(ref, track)
    axis = axis_of(ref, track, F if kind == "land" else F - 1)
    if axis is None: raise SystemExit(f"unknown track {track}")
    ez = a.easing or ("Cubic Out" if kind == "land" else "Cubic In")
    if ez not in easing.CURVES and ez not in ("Linear",): raise SystemExit(f"unknown easing {ez!r}")
    L = a.frames or (20 if axis == "zoom" else 15)
    keys = copy.deepcopy(ref.keys(track) or [])
    p_seam = min(100.0, max(0.0, ref.pos(F)))      # the item starts / ends a hair before the seam frame
    p_far = ref.pos(F + L) if kind == "land" else ref.pos(F - L)
    if not (-1e-6 <= min(p_seam, p_far) and max(p_seam, p_far) <= 100 + 1e-6):
        raise SystemExit(f"the {L}-frame move does not fit in the item (positions {p_seam:.1f}–{p_far:.1f} %): pass --frames")
    base = value_at(keys, p_far) if keys else float(ref.item.get(PATH_T) or 0) if track == PATH_T else DEFAULT_VALUE.get(track, 0.0)
    # rows seam_check will average on this side
    if seam is not None:
        rows = side_rows(seam, "in" if kind == "land" else "out", ref)
    else:
        rows = [F + 1, F + 2] if kind == "land" else [F - 3, F - 2, F - 1]
    kk = {"easing": ez}
    prog = lambda f: ease_u(kk, (f - F) / L) if kind == "land" else ease_u(kk, (f - (F - L)) / L)
    mean_dE = float(np.mean([prog(f) - prog(f - 1) for f in rows]))
    # the velocity wanted on those rows, in track units / f (zoom: log units / f)
    if a.velocity is not None:
        V, why = float(a.velocity), "given"
    else:
        other = seam_mean(seam, "out" if kind == "land" else "in", axis)
        tgt = other * a.ratio if kind == "land" else other / a.ratio
        ku = k_units(track, ref, meta, at_f=F if kind == "land" else F - 1)
        if ku is None: raise SystemExit(f"cannot convert {track} to screen units: pass --velocity")
        V = (math.log(1 + tgt / 100) if track in RATIO_TRACKS else tgt / ku)
        why = f"from seams: other side {axis} {other:+.3f} × {a.ratio if kind == 'land' else 1 / a.ratio:.3f} → {tgt:+.3f} screen, k {ku:.4g}"
    if abs(mean_dE) < 1e-9: raise SystemExit(f"{ez} does not move on the seam rows {rows}")
    D = V / mean_dE                                  # Δ over the move (track units, or log units for zoom tracks)
    if track in RATIO_TRACKS:
        v_seam = base * math.exp(-D) if kind == "land" else base * math.exp(D)
    else:
        v_seam = base - D if kind == "land" else base + D
        if track == PATH_T and (path_live(ref.item) or {}).get("closed") is not True and not -1e-6 <= v_seam <= 100 + 1e-6:
            raise SystemExit(f"{spec}: the move needs progress {v_seam:.2f} %, past the path's end (it is 0–100 on an open "
                             "path): lengthen the path, or pass a smaller --velocity or fewer --frames")
    lo, hi = sorted((p_seam, p_far))
    seg_easing = None
    if keys:
        ks = sorted_keys(keys); j = seg_index(ks, p_far, "in" if kind == "land" else "out")
        if j is not None: seg_easing = ks[j].get("easing")
    kept = [k for k in keys if not (lo - 1e-6 <= float(k["position"]) <= hi + 1e-6)]
    if kind == "land":
        new = [dict(position=round(p_seam, 4), value=str(round(v_seam, 4)), easing=ez),
               dict(position=round(p_far, 4), value=str(round(base, 4)), easing=seg_easing or "Linear")]
    else:
        new = [dict(position=round(p_far, 4), value=str(round(base, 4)), easing=ez),
               dict(position=round(p_seam, 4), value=str(round(v_seam, 4)), easing="Linear")]
    # keys on the far side of the move keep their own easing; a key after the land segment keeps playing
    nk = sorted_keys(kept + new)
    e0 = (ease_u(kk, 1 / L) - 0) * L if kind == "land" else (1 - ease_u(kk, 1 - 1 / L)) * L
    rep = dict(cmd=kind, seam=F, changes=[dict(path=ref.path, track=track, side="in" if kind == "land" else "out",
                                                  frames=sorted([F, F + L if kind == "land" else F - L]), easing=ez, L=L,
                                                  base=round(base, 4), seam_value=round(v_seam, 4), delta=round(D, 5),
                                                  velocity=round(V, 5), velocity_why=why, rows=rows, E_seam_frame=round(e0, 3),
                                                  before=ref.keys(track), keys=nk)])
    return rep


def apply(d, rep):
    """write the planned tracks into d (fresh data), by path"""
    for c in rep["changes"]:
        ref = resolve(d, c["path"], rep["seam"] if c["side"] == "in" else rep["seam"] - 1)
        pk = ref.item.setdefault("propertyKeyframes", {})
        pk[c["track"]] = c["keys"]


def plan(d, a, seam, meta):
    if a.cmd == "match": return plan_match(d, a, seam, meta)
    return plan_static(d, a, seam, meta, a.cmd)


# ── inspect ───────────────────────────────────────────────────────────────────────────────────────────────────────
def inspect(d, a):
    at = a.at_frame if a.at_frame is not None else 0
    ref = resolve(d, a.item, at)
    pk = ref.item.get("propertyKeyframes") or {}
    print(f"{ref.path}: film frames {ref.start_f:.2f}–{ref.start_f + ref.n_f:.2f} ({ref.n_f:.2f} f), "
          f"sequence zoom ×{ref.chain_zoom:g}{' (camera clip)' if ref.camera else ''}")
    mode = camera_mode(ref)
    if mode and mode != "free":
        always, maybe = CAM_OVERRIDES.get(mode, ((), ()))
        print(f"  cameraMoveMode {mode!r}: keys on {', '.join(always + maybe)} render as nothing"
              + (" (the last ones only with a live path / an aimed rig)" if maybe else "") + "; set \"free\" to drive them")
    mp = path_live(ref.item)
    if mp:
        n = len(mp["points"])
        print(f"  motion path: {n} anchors, {'closed' if mp.get('closed') is True else 'open'}; {PATH_T} 0–100 runs it, an "
              f"equal share per segment (so its speed follows the anchors' spacing)")
    tracks = [a.track] if a.track else sorted(pk)
    if not tracks: print("  no keyed tracks")
    for t in tracks:
        keys = pk.get(t)
        if not keys: print(f"  {t}: no keys"); continue
        ks = sorted_keys(keys)
        print(f"  {t}: {len(ks)} keys" + (f"  (expression: {ref.item.get('propertyKeyframeFx', {}).get(t, {}).get('type')})" if t in (ref.item.get('propertyKeyframeFx') or {}) else ""))
        for i in range(len(ks) - 1):
            k0, k1 = ks[i], ks[i + 1]
            pa, pb = float(k0["position"]), float(k1["position"]); fa, fb = ref.frame(pa), ref.frame(pb)
            T = max(1e-9, fb - fa); dv = float(k1["value"]) - float(k0["value"])
            s0, s1 = slopes(k0); bz, approx = bezier_of(k0)
            mark = " <- at F" if a.at_frame is not None and fa <= a.at_frame <= fb else ""
            print(f"    seg {i}: {pa:6.2f}→{pb:6.2f} %  f{fa:7.2f}→f{fb:7.2f}  {k0['value']}→{k1['value']}  "
                  f"{k0.get('easing') or 'Linear'}{' ' + str(k0.get('bezier')) if k0.get('easing') == 'Custom' else ''}"
                  f"{' easeSlice' if k0.get('easeSlice') else ''}  E'(0) {s0:.3f} E'(1) {s1:.3f}  "
                  f"v_start {dv / T * s0:+.4g}/f v_end {dv / T * s1:+.4g}/f{mark}")
        if a.at_frame is not None:
            print(f"    frames around f{a.at_frame} (value, row = f−1→f):")
            for f in range(a.at_frame - 12, a.at_frame + 13):
                if not (ref.start_f - 1e-6 <= f <= ref.start_f + ref.n_f + 1e-6): continue
                v = value_at(ks, ref.pos(f))
                r = rows_pred(ks, ref, t, [f])[0] if f - 1 >= ref.start_f - 1e-6 else None
                on = ""
                if t == PATH_T and mp:
                    x1, y1 = path_screen(ref, v)
                    on = f"   screen ({x1:8.1f}, {y1:8.1f})"
                    if r is not None:
                        x0, y0 = path_screen(ref, value_at(ks, ref.pos(f - 1)))
                        on += f"  {x1 - x0:+8.2f} {y1 - y0:+8.2f} px/f"
                print(f"      f{f:5d}  {v:12.4f}  {'' if r is None else ('%+.4f' % r) + ('%/f' if t in RATIO_TRACKS else '/f')}{on}")


# ── main ──────────────────────────────────────────────────────────────────────────────────────────────────────────
def print_plan(rep):
    print(f"{rep['cmd']} seam f{rep['seam']}")
    if rep.get("measured"): print("  measured:", json.dumps(rep["measured"]))
    for c in rep["changes"]:
        print(f"  {c['path']}:{c['track']} ({c['side']} side)")
        for k in ("segment", "frames", "before", "after", "k", "rows", "measured_mean", "predicted_mean", "target",
                  "easing", "L", "base", "seam_value", "delta", "velocity", "velocity_why", "E_seam_frame", "notes"):
            if c.get(k) not in (None, []): print(f"    {k}: {json.dumps(c[k], ensure_ascii=False)}")
        print(f"    keys after: {json.dumps(c['keys'])}")
    if rep.get("predicted"): print("  predicted at the seam:", json.dumps(rep["predicted"]))


def main():
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--board", default=kitlib.env("BOARD"), help="board id (default $SEAM_BOARD)")
    common.add_argument("--project", default=kitlib.env("PROJECT"), help="project id (default $SEAM_PROJECT)")
    common.add_argument("--work", default=kitlib.env("WORK", "."), help="folder for seam_fit_log.jsonl and vp's patch_log.jsonl (default $SEAM_WORK or .)")
    common.add_argument("--dry-run", action="store_true", help="print the patch, write nothing")
    common.add_argument("--fps", type=float, default=30.0, help="the project's frame rate (default 30)")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("inspect", parents=[common], help="the item's keyed tracks and their slopes")
    s.add_argument("--item", required=True); s.add_argument("--track"); s.add_argument("--at-frame", type=int)
    s = sub.add_parser("match", parents=[common], help="rewrite the segments at a seam so the speeds meet")
    s.add_argument("--seams", required=True); s.add_argument("--seam", type=int, required=True)
    s.add_argument("--in", dest="inn"); s.add_argument("--out")
    s.add_argument("--ratio", type=float, default=1.2, help="in speed / out speed (default 1.2)")
    s.add_argument("--out-slope", type=float, default=3.0, help="end slope E'(1) of the out segment (default 3, like Ease In)")
    s.add_argument("--out-velocity", type=float, help="the out side's mean speed on its seam rows, screen units (px/f or %%/f)")
    s.add_argument("--soft-landing", action="store_true", help="the in segment also ends at rest (end handle 0.5, 1)")
    for kind, side in (("land", "--in"), ("exit", "--out")):
        s = sub.add_parser(kind, parents=[common], help=f"add the {kind} move of a static side")
        s.add_argument("--seam", type=int, required=True)
        s.add_argument(side, dest="inn" if side == "--in" else "out", required=True)
        g = s.add_mutually_exclusive_group(required=True)
        g.add_argument("--velocity", type=float, help="track units per frame (signed; zoom tracks: log units per frame)")
        g.add_argument("--from-seams", help="seams.json: take the other side's measured velocity")
        s.add_argument("--frames", type=int, help="L: length of the move (default 15 pan, 20 zoom)")
        s.add_argument("--easing"); s.add_argument("--ratio", type=float, default=1.2)
    a = ap.parse_args()
    for k in ("inn", "out"):
        if not hasattr(a, k): setattr(a, k, None)
    global FPS
    FPS = a.fps
    vp.configure(board=a.board, project=a.project, work_dir=a.work)
    if not a.board or not a.project: raise SystemExit("pass --board and --project")
    data, ver = vp.get()
    if a.cmd == "inspect":
        inspect(data, a); return
    if a.cmd == "match" and not (a.inn or a.out): raise SystemExit("match needs --in and/or --out")
    seam, meta = None, {}
    src = getattr(a, "seams", None) or getattr(a, "from_seams", None)
    if src:
        seam, j = load_seam(src, a.seam)
        meta = dict(width=j.get("width"), height=j.get("height"), render=j.get("render"))
        a.seam = seam["film_f"]
    rep0 = plan(copy.deepcopy(data), a, seam, meta)
    print_plan(rep0)
    if a.dry_run:
        print(f"DRY RUN: nothing written (project version stays {ver})"); return
    runs = []

    def change(d):                     # fresh data on every try: the plan is recomputed from it
        rep = plan(d, a, seam, meta); apply(d, rep); runs.append(rep)

    r = vp.patch(change, who="seam_fit", note=f"{a.cmd} seam {a.seam}", allow_overlap=True)
    rep = runs[-1]
    os.makedirs(a.work, exist_ok=True)
    with open(os.path.join(a.work, "seam_fit_log.jsonl"), "a") as f:
        f.write(json.dumps(dict(t=time.strftime("%Y-%m-%d %H:%M:%S"), board=a.board, project=a.project, cmd=a.cmd, seam=a.seam,
                                version_from=ver, version_to=(r or {}).get("version"), tries=len(runs),
                                changes=[{k: v for k, v in c.items() if k != "keys"} | {"keys": c["keys"]} for c in rep["changes"]],
                                predicted=rep.get("predicted")), ensure_ascii=False) + "\n")
    print(f"written: version {ver} -> {(r or {}).get('version')} ({len(runs)} {'try' if len(runs) == 1 else 'tries'})")


if __name__ == "__main__":
    main()
