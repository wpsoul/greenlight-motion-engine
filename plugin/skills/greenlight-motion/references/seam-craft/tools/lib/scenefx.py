"""scenefx.py — scene seams in a GLEA project: build a join by changing the scenes at it (spec: ../../scene-seams.md;
GLEA usage: ../../scene-seams.md, "In the Video Editor").

Generic building blocks, not looks: WHAT carries each join comes from the film's own frames, every film anew (the
uniqueness rules in scene-seams.md). Pure functions on a Video Editor project's `data` (edit it in place inside a
`vp.patch` change function, or on a copy you PUT yourself). Assumes 30 fps film frames and a 16:9 1920×1080 project
(FPS, W, H below; the frame centre C): convert your numbers, or set those module values, for another size. Tested on
real renders, checked frame by frame:

    push_into(item, f0, f1, S1, point)        camera push into a point of a full-frame item (screen, pill, card)
    fitted(item, track, frames, fn)           any curve you computed, written as the fewest eased keys
    blur_ramp(item, f_from, f_to, peak)       a blur that never draws the black frame (Hold at 0, step to 1.5)
    shape_window(d, after_ch, tag, f0, f1, …) a shape matte that follows a shape on screen; the next world inside it
    mark_iris(d, after_ch, tag, f0, f1, …)    the brand mark closes the shot: black outside it, it shrinks to a point
    hold_camera_exit(d, seq_clip_id, key_idx) a path-camera world keeps its framing from camera key key_idx on
    new_channel / new_clip / new_item         safe new layers (unsnapped channels, synthetic clips longer than items)

Every move is written as the FEWEST eased keys (lib/keyfit.py): a push is 2 keys per track with one Custom bezier (3 on the scale at some end scales),
never a key on every frame. A fitted track never leaves the range of its curve (a scale from rest never dips under ×1). Compute a curve as densely as you like and hand it to `fitted`. Needs numpy (and scipy
for the tightest fit; without it the same tolerance is met with a few more keys).

Rules baked in (each one cost a render to find):
- a new channel must be `unsnapped: true`, or `freeStart` is ignored and the item sits at 0 s;
- a synthetic (shape) clip shorter than its item's trimEnd is not drawn: clip duration = item span + 1 s;
- a `blur` track easing up from 0 draws one fully black frame on a sequence item: hold 0, then step to ≥ 1.5;
- a matte source and its consumers live at the same level, on their own channels, over the same frames
  (no source under the playhead = an empty matte: `alpha` hides the consumer, `alphaInverted` shows it whole).
"""
import math, os, sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import keyfit  # noqa: E402

FPS = 30.0
C = (960.0, 540.0)
W, H = 1920.0, 1080.0


# ── items and keys ────────────────────────────────────────────────────────────────────────────────────────────────
def speed(it):
    sp = it.get("speedPoints")
    return float(sp[0]["y"]) if sp else float(it.get("speed") or 1)


def span(it):
    """the item's length on the timeline, s"""
    return (float(it["trimEnd"]) - float(it.get("trimStart") or 0)) / speed(it)


def pos(it, f):
    """key position (% of the item) of film frame f, clamped to 0…100"""
    return max(0.0, min(100.0, round((f / FPS - float(it["freeStart"])) / span(it) * 100, 4)))


def end_f(it):
    return (float(it["freeStart"]) + span(it)) * FPS


def key(p, v, e="Linear", bz=None):
    k = {"position": round(p, 4), "value": str(round(v, 5) if isinstance(v, float) else v), "easing": e}
    if bz: k["easing"] = "Custom"; k["bezier"] = list(bz)
    return k


def tracks(it):
    return it.setdefault("propertyKeyframes", {})


# the largest miss a scene seam may have, per track (value, relative). Position and rotation are tighter than
# keyfit's own: a matte and the shape it follows must sit on each other. Scale keeps keyfit's 0.3 %: a layer that
# follows a push takes the curve the push's keys PLAY (what push_into returns), so the two agree far inside it, and
# 0.3 % keeps a ×4–12 push at 2 keys.
TOL = {"scale": (0.003, True), "scaleX": (0.003, True), "scaleY": (0.003, True),
       "translateX": (0.5, False), "translateY": (0.5, False), "rotate": (0.1, False)}
REST = {"scale": 1.0, "scaleX": 1.0, "scaleY": 1.0}                   # a track that never leaves this value is dropped


def fitted(it, track, frames, fn, tol=None, rel=None, nd=4, max_keys=12):
    """the curve fn(film frame) over `frames` as the fewest eased keys on the item's `track` (Custom beziers within
    the tolerance: TOL above, else keyfit's for the track). A move is its keys and their easing: one eased move comes
    out as 2 keys, a move that changes direction as 3–5. A curve that stays at the track's rest value writes no track.
    Replaces the track. Returns at(f): the value the written keys play at film frame f (the first and last key hold
    outside the range), so a second layer can follow exactly what was written."""
    fr = [float(f) for f in frames]; vs = [float(fn(f)) for f in fr]
    t0, r0 = TOL.get(track) or keyfit.tolerance(track, vs)
    tol = t0 if tol is None else tol; rel = r0 if rel is None else rel
    keys, err = keyfit.fit(fr, vs, tol, rel, max_keys=max_keys)
    if err > tol:
        print("scenefx.fitted: %s %s still misses by %g at %d keys (tolerance %g): the curve is noisy (smooth the "
              "measurement first) or holds two moves" % (it.get("id"), track, err, len(keys), tol), file=sys.stderr)
    if len(keys) == 1 and abs(keys[0][1] - REST.get(track, 0.0)) < 1e-9:
        tracks(it).pop(track, None)
    else:
        out = []
        for t, v, bz in keys:
            k = key(pos(it, t), round(float(v), nd), bz=bz and [round(float(x), 4) for x in bz])
            if out and out[-1]["position"] == k["position"]: out[-1] = k       # an item shorter than the range
            else: out.append(k)
        out[-1]["easing"] = "Linear"; out[-1].pop("bezier", None)
        tracks(it)[track] = out
    return lambda f: float(keyfit.evaluate(np.array([float(f)]), keys)[0])


def turns(it):
    """True when the item is rotated, by a field or a track (its transform origin is then already in use)"""
    return any(float(it.get(k) or 0) for k in ("rotateX", "rotateY", "rotateZ", "rotation")) or \
        any(tracks(it).get(k) for k in ("rotate", "rotateX", "rotateY"))


def rest_center(it):
    """the item's centre on screen at rest: the frame centre moved by its static pan (% of the frame)"""
    return (C[0] + float(it.get("panX") or 0) * W / 100, C[1] + float(it.get("panY") or 0) * H / 100)


def origin_at(it, point):
    """the `keyframeTransformOrigin` ("x% y%" of the item's box) that puts the pivot on screen point `point` of a
    full-frame item (its box is the frame, sized by its static zoom)"""
    c = rest_center(it); z = float(it.get("zoom") or 1) or 1
    return "%s%% %s%%" % (round(50 + (point[0] - c[0]) / (W * z * float(it.get("scaleX") or 1)) * 100, 3),
                          round(50 + (point[1] - c[1]) / (H * z * float(it.get("scaleY") or 1)) * 100, 3))


def find_item(d, iid, channels=None):
    for ch in (channels if channels is not None else d["channels"]):
        for it in ch["items"]:
            if it["id"] == iid: return ch, it
    raise KeyError(iid)


def find_clip(d, cid):
    return next(c for c in d["clips"] if c["id"] == cid)


def new_channel(d, after_id, cid, name):
    """a new channel right above `after_id` (later in the list = higher in the stack)"""
    for n, ch in enumerate(d["channels"]):
        if ch["id"] == cid: return ch                       # idempotent on re-runs
    i = next(n for n, ch in enumerate(d["channels"]) if ch["id"] == after_id)
    ch = {"id": cid, "name": name, "visible": True, "unsnapped": True, "items": []}
    d["channels"].insert(i + 1, ch)
    return ch


def new_clip(d, cid, media, name, dur, url=""):
    for c in d["clips"]:
        if c["id"] == cid: return c
    c = {"id": cid, "source": "REMOTE" if url else "LOCAL", "mediaType": media, "url": url, "name": name,
         "duration": round(dur + (0 if url else 1.0), 4)}
    if not url: c["proxyUrl"] = None
    d["clips"].append(c)
    return c


def new_item(ch, clip, iid, f0, f1, name, src0=0.0, **fields):
    it = {"id": iid, "clipId": clip["id"], "freeStart": round(f0 / FPS, 4), "trimStart": round(src0, 4),
          "trimEnd": round(src0 + (f1 - f0) / FPS, 4), "transition": "None", "transitionDuration": 0, "customName": name}
    it.update(fields)
    ch["items"] = [x for x in ch["items"] if x["id"] != iid] + [it]
    return it


def rect_shape(w, h, fill="#000000", radius=None):
    f = {"shapeType": "rectangle", "shapeSizeUnit": "px", "shapeWidthPx": w, "shapeHeightPx": h, "shapeFillColor": fill}
    if radius is not None: f["borderRadius"] = radius
    return f


def uncovered(it, f0, f1):
    """(px, first film frame, last film frame): how far a full-frame item's box pulls inside the frame while its
    `scale` / `translateX` / `translateY` keys play f0…f1, about its transform origin; (0, None, None) when it always
    covers the frame"""
    import easing
    c = rest_center(it); z = float(it.get("zoom") or 1) or 1
    o = c
    m = (it.get("keyframeTransformOrigin") or "").split()
    if len(m) == 2 and all(x.endswith("%") for x in m):
        o = (c[0] + (float(m[0][:-1]) / 100 - 0.5) * W * z, c[1] + (float(m[1][:-1]) / 100 - 0.5) * H * z)
    val = lambda tr, f, rest: easing.track(tracks(it)[tr], pos(it, f)) if tracks(it).get(tr) else rest
    worst, first, last = 0.0, None, None
    for f in range(int(f0), int(f1) + 1):
        s = val("scale", f, 1.0); tx = val("translateX", f, 0.0); ty = val("translateY", f, 0.0)
        x0, x1 = o[0] + s * (c[0] - W * z / 2 - o[0]) + tx, o[0] + s * (c[0] + W * z / 2 - o[0]) + tx
        y0, y1 = o[1] + s * (c[1] - H * z / 2 - o[1]) + ty, o[1] + s * (c[1] + H * z / 2 - o[1]) + ty
        gap = max(x0, W - x1, y0, H - y1, 0.0)
        if gap > 0.5:
            worst = max(worst, gap); first = f if first is None else first; last = f
    return round(worst, 1), first, last


# ── moves ─────────────────────────────────────────────────────────────────────────────────────────────────────────
def push_fns(f0, f1, S1, point, Q1=C, powr=3.0, point_of=None, travel=None):
    """a camera push into `point` (screen px at f0) of a full-frame item scaled about the frame centre:
    S(f) = S1^(u^powr) (an ease-in on the log scale: it starts at rest and accelerates into the cut);
    the point's image travels to Q1 by u^travel, and `travel` defaults to `powr`: the point then never runs ahead of
    the zoom, so the item keeps covering the frame (a travel by u² under a u³ zoom opened 6 px of the frame's edge
    for 7 frames of a ×4.5 push). `point_of(f)` = the point's own screen position per frame when the content
    drifts by itself (measured, e.g. with carrier_box.py); the push then compensates the drift.
    Returns S(f), T(f) -> (tx, ty) translate px, Q(f) -> the point's screen position."""
    travel = powr if travel is None else travel
    def u(f): return max(0.0, min(1.0, (f - f0) / (f1 - f0)))
    def S(f): return S1 ** (u(f) ** powr)
    def Q(f): return tuple(point[a] + (Q1[a] - point[a]) * u(f) ** travel for a in (0, 1))
    def P(f): return point_of(f) if point_of else point
    def T(f):
        q, p, s = Q(f), P(f), S(f)
        return tuple(q[a] - C[a] - s * (p[a] - C[a]) for a in (0, 1))
    return S, T, Q


def push_into(it, f0, f1, S1, point, Q1=C, powr=3.0, point_of=None, until_f=None, pivot=True, drift_tol=1.5, travel=None):
    """write the push on a full-frame item as the fewest eased keys, f0 to f1 (the first key holds before f0, the
    last one to the item's end; `until_f` is not needed and is ignored). Replaces `scale`, `translateX`, `translateY`.
    - `scale` grows ABOUT THE POINT: the item's `keyframeTransformOrigin` is set to it, so the point stays put however
      the scale is eased (2 keys);
    - `translateX` / `translateY` carry the point to Q1 on the zoom's own curve (u^powr; `travel` sets another
      exponent), 2 keys each; no track on an axis it does not travel. The item covers the frame through the whole
      push unless the point sits nearer to the frame's edge than about (its way to Q1) / ln(S1): then it says so;
    - `point_of(f)`, a measured drift of the content, is smoothed to `drift_tol` px first (a measurement steps by
      ±1 px, and those steps × the scale would be keyed), then compensated in the translate keys.
    An item that is rotated keeps its own origin: the scale stays about its centre and the translate keys compensate
    (`pivot=False` asks for that). Returns S(f), T(f) -> (tx, ty) and Q(f) -> the point on screen: what the written
    keys play, for a layer that must follow the push (shape_window)."""
    S0, _, Q = push_fns(f0, f1, S1, point, Q1, powr, travel=travel)
    fr = list(range(int(f0), int(f1) + 1))
    P = lambda f: point
    if point_of:                                           # the drift itself as two smooth curves
        px, _ = keyfit.fit(fr, [point_of(f)[0] for f in fr], drift_tol); py, _ = keyfit.fit(fr, [point_of(f)[1] for f in fr], drift_tol)
        ev = lambda keys, f: float(keyfit.evaluate(np.array([float(f)]), keys)[0])
        d0 = (point[0] - ev(px, fr[0]), point[1] - ev(py, fr[0]))             # the drift starts on the point
        P = lambda f: (ev(px, f) + d0[0], ev(py, f) + d0[1])
    for tr in ("scale", "translateX", "translateY"): tracks(it).pop(tr, None)
    if pivot and not turns(it):
        o = tuple(point); it["keyframeTransformOrigin"] = origin_at(it, point)
    else:
        o = rest_center(it)
    S = fitted(it, "scale", fr, S0)
    T0 = lambda f, a: Q(f)[a] - o[a] - S(f) * (P(f)[a] - o[a])                 # with the scale the keys really play
    tx = fitted(it, "translateX", fr, lambda f: T0(f, 0)); ty = fitted(it, "translateY", fr, lambda f: T0(f, 1))
    gap, ga, gb = uncovered(it, f0, f1)
    if gap:
        why = ("compensating the content's own drift moves the layer before the zoom has grown" if point_of and gap < 3 else
               "the point is too near the frame's edge for its way to Q1 at this end scale, or `travel` is below `powr`")
        print("scenefx.push_into: %s leaves up to %g px of the frame uncovered on film frames %d–%d (%s): aim at a "
              "nearer Q1, raise S1, or keep a layer or the project background under it"
              % (it.get("id"), gap, ga, gb, why), file=sys.stderr)
    return S, (lambda f: (tx(f), ty(f))), Q


def blur_ramp(it, f_from, f_to, peak, step=1.5, easing="Cubic In"):
    """blur 0 until f_from, then step → peak by f_to, held to the end (the step avoids the one black frame a blur
    rising from 0 draws on a sequence item)."""
    tracks(it)["blur"] = [key(pos(it, f_from), 0.0, "Hold"), key(pos(it, f_from + 1), step, easing),
                          key(pos(it, f_to), float(peak))]            # the first key holds before it, the last after


def hold_camera_exit(d, seq_clip_id, key_idx):
    """a path-camera world (camPathT on cameraPath) keeps its framing from key `key_idx` to the end: every camera
    track's next key takes that key's value, the segment goes Linear. Use before pushing into something the world
    shows (its exit would carry the target off screen). key_idx: the index (in position order) of the camera key whose
    framing you keep, usually the last key before the exit move starts; read the keys first
    (seam_fit.py inspect --item SEQ_ITEM/camera --at-frame F)."""
    seq = find_clip(d, seq_clip_id)["sequence"]
    cam = next(i for ch in seq["channels"] for i in ch["items"] if i.get("cameraPath") or "camPathT" in (i.get("propertyKeyframes") or {}))
    for tr, ks in cam["propertyKeyframes"].items():
        if tr.startswith("cam") and len(ks) > key_idx + 1:
            for k in ks[key_idx + 1:]: k["value"] = ks[key_idx]["value"]
            ks[key_idx]["easing"] = "Linear"; ks[key_idx].pop("bezier", None)
    return cam


# ── windows and irises ────────────────────────────────────────────────────────────────────────────────────────────
def shape_window(d, after_ch, tag, f0, f1, size, scale_of, center_of, inside=(), radius=None, open_f=4, plate="#000000"):
    """the shape on screen becomes a window onto the next world.
    size = (w, h) of the shape at scale 1 (measure it, take ~97 % so the rim stays); scale_of(f) and center_of(f) ->
    (x, y) screen px follow the shape (push_into's S and Q: the matte then gets the same few eased keys as the push,
    so the rim holds between frames too). Above `after_ch` it adds: a dark plate (`plate`) and
    every `inside` layer, each matted by one hidden shape item; they fade in over `open_f` frames (the shape's face
    darkens, its label melts) while the push carries the eye into it.
    inside: [{"clip": clip_id, "src0": s, "name": …, **fields}] — e.g. the next world's still backdrop (held still:
    the window moves, the world inside does not). Returns the matte item."""
    f_end = f1 + 0.5                                                 # ends half a frame past the cut
    w, h = size
    chm = new_channel(d, after_ch, f"{tag}-matte", f"{tag} · window matte (hidden)")
    cm = new_clip(d, f"{tag}-c-matte", "shape", f"{tag} · window matte", (f_end - f0) / FPS)
    mt = new_item(chm, cm, f"{tag}-matte-it", f0, f_end, f"{tag} · window matte (follows the shape)",
                  **rect_shape(w, h, "#ffffff", round(h / 2, 1) if radius is None else radius))
    fr = range(int(f0), int(f1) + 1)
    fitted(mt, "scale", fr, scale_of)                                # the push's own curves give the push's own keys
    fitted(mt, "translateX", fr, lambda f: center_of(f)[0] - C[0])
    fitted(mt, "translateY", fr, lambda f: center_of(f)[1] - C[1])
    below = after_ch
    layers = [dict(clip=None, name="the dark inside")] + list(inside)
    for n, spec in enumerate(layers):
        spec = dict(spec)
        ch = new_channel(d, below, f"{tag}-in{n}", f"{tag} · inside the window {n}")
        below = ch["id"]
        if spec.pop("clip") is None:
            c = new_clip(d, f"{tag}-c-plate", "shape", f"{tag} · window plate", (f_end - f0) / FPS)
            it = new_item(ch, c, f"{tag}-in{n}-it", f0, f_end, f"{tag} · {spec.pop('name')}", **rect_shape(W, H, plate),
                          trackMatte={"sourceId": mt["id"], "mode": "alpha"})
        else:
            c = find_clip(d, layers[n]["clip"]); src0 = spec.pop("src0", 0.0)
            it = new_item(ch, c, f"{tag}-in{n}-it", f0, f_end, f"{tag} · {spec.pop('name', 'inside')}", src0=src0,
                          trackMatte={"sourceId": mt["id"], "mode": "alpha"}, **spec)
        tracks(it)["opacity"] = [key(0.0, 0.0, "Sine Out"), key(pos(it, f0 + open_f), 1.0)]
    # the matte channel must sit above the consumers only for tidiness; stacking does not matter for a matte source
    return mt


def mark_iris(d, after_ch, tag, f0, f1, mark_url, center, S0=2.3, rot=-75.0, powr=2.2, fade_f=8, feather=(1.5, 6.0),
              mark_px=1024):
    """the brand mark closes the shot it sits above (`after_ch`): a black frame-size layer with an alphaInverted
    matte on the mark (black outside the mark) fades in over `fade_f`, the mark shrinks from S0 (× its PNG size at
    zoom 1) to a point by f1 with an ease-in (powr), turning `rot` degrees: 2 eased keys each. Centre it on the last
    hero of the shot.
    mark_url: a PNG of the real mark with alpha (white on transparent). Returns (black item, mark item)."""
    f_end = f1 + 0.5
    chb = new_channel(d, after_ch, f"{tag}-black", f"{tag} · black outside the mark")
    chi = new_channel(d, chb["id"], f"{tag}-mark", f"{tag} · mark iris matte (hidden)")
    cb = new_clip(d, f"{tag}-c-black", "shape", f"{tag} · black", (f_end - f0) / FPS)
    ci = new_clip(d, f"{tag}-c-mark", "image", f"{tag} · brand mark (matte)", max(10.0, (f_end - f0) / FPS + 1), url=mark_url)
    cx, cy = center
    ir = new_item(chi, ci, f"{tag}-mark-it", f0, f_end, f"{tag} · mark iris (matte source)", zoom=1.0,
                  panX=round((cx - C[0]) / (W / 100), 4), panY=round((cy - C[1]) / (H / 100), 4))
    fr = list(range(int(f0), int(math.floor(f1)) + 1)); n = max(1, len(fr) - 1)
    fitted(ir, "scale", fr, lambda f: max(0.0, S0 * (1 - ((f - f0) / n) ** powr)), tol=0.002, rel=False)   # → 0: an absolute miss
    fitted(ir, "rotate", fr, lambda f: rot * ((f - f0) / n) ** powr)
    tracks(ir)["blur"] = [key(0.0, feather[0]), key(100.0, feather[1])]
    bk = new_item(chb, cb, f"{tag}-black-it", f0, f_end, f"{tag} · black outside the mark", **rect_shape(W, H, "#000000"),
                  trackMatte={"sourceId": ir["id"], "mode": "alphaInverted"})
    tracks(bk)["opacity"] = [key(0.0, 0.0, "Sine Out"), key(pos(bk, f0 + fade_f), 1.0)]
    return bk, ir
