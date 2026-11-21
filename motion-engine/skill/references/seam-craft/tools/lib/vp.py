#!/usr/bin/env python3
"""vp.py — safe shared edits of ONE Video Editor project while other sessions (or the user's open editor) may write it
too: versioned writes, overlap checks (nested sequences included), upsert/remove, frame-exact times, range renders.

As a module:
    import sys; sys.path.insert(0, "<this skill's folder>/references/video/seam-craft/tools/lib"); import vp
    vp.configure(board="BOARD_ID", project="PROJECT_ID", work_dir="work")   # or $SEAM_BOARD / $SEAM_PROJECT / $SEAM_WORK
    data, ver = vp.get()                                   # the last saved copy (a read-only look)
    def my_change(d):                                      # edit ONLY your own items, in place, on the FRESH data given
        vp.item(d, "ITEM_ID")["zoom"] = 1.0
    vp.patch(my_change, who="seam pass", note="seam at 14.0 s: landing", lo_f=0, hi_f=130)   # GET → fn → overlap check → PUT, retries 409
    vp.render_frames(0, 125, "checks/p1.mp4")              # film frames 0…125 with the full renderer, kept off the board

Rules (why: several writers can hold one project at once): never PUT a payload you built earlier — change it inside fn,
which gets fresh data; fn must be idempotent (it may run again after a 409). patch refuses a write that leaves two
visual items overlapping on one channel (also inside nested sequences) unless allow_overlap=True. Every write is
logged to <work_dir>/patch_log.jsonl. Never rename a media file an earlier version references (an open editor can
write its stale copy back) — publish new files under new names.

Assumes 30 fps: render jobs are sent at fps 30 and the frame helpers use n/30. The render size is the project's own
unless --width/--height are given.

As a command:
    vp.py get [--out project.json]                         print / save the project (data + version)
    vp.py overlaps [--lo-f F] [--hi-f F]                   visual overlaps per channel (top level + every sequence)
    vp.py dump [--lo-f F] [--hi-f F]                       the items live in a frame window (channel, id, frames, clip)
    vp.py render F0 F1 OUT.mp4 [--width W --height H] [--renderer webgl|webgpu]
                                                           film frames F0…F1 (rangeEnd = (F1 + 0.5)/30: N/30 returns
                                                           one extra black frame); default size = the project's,
                                                           renderer = the app's engine
    vp.py still TIME_S OUT.png                             /render-still (not saved to the board)
    vp.py --dry-run …                                      prints the API calls instead of making them (no server needed)
    vp.py --project-json P.json get|overlaps|dump          read the project from a saved GET instead of the API
Global flags go before the command: vp.py --board B --project P [--work-dir DIR] render 100 160 out.mp4
Board and project come from --board/--project, else --config, else $SEAM_BOARD/$SEAM_PROJECT (the older
$VRX_BOARD/$VRX_PROJECT still work); the work folder from --work-dir, else $SEAM_WORK, else the current folder.
"""
import argparse, base64, copy, json, os, sys, time, urllib.error, urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))   # tools/lib: kitlib sits beside this file
import kitlib  # noqa: E402

FPS = 30
_C = {"board": kitlib.env("BOARD"), "project": kitlib.env("PROJECT"), "work_dir": kitlib.env("WORK", "."),
      "dry": False}
if kitlib.env("CONFIG"):
    _f = json.load(open(kitlib.env("CONFIG")))
    _C.update({k: _f[k] for k in ("board", "project", "work_dir") if _f.get(k)})


def configure(board=None, project=None, work_dir=None, config=None, dry=None):
    if config:
        f = json.load(open(config)); _C.update({k: f[k] for k in ("board", "project", "work_dir") if f.get(k)})
    for k, v in (("board", board), ("project", project), ("work_dir", work_dir), ("dry", dry)):
        if v is not None: _C[k] = v


def _need():
    if not _C["board"] or not _C["project"]:
        sys.exit("vp: no board/project — pass --board/--project, --config, or set $SEAM_BOARD/$SEAM_PROJECT")
    return _C["board"], _C["project"]


def call(m, p, b=None, timeout=600):
    if _C["dry"]:
        print("DRY", m, p, (json.dumps(b)[:200] + "…") if b is not None else ""); return None
    return kitlib.call(m, p, b, timeout=timeout)


# ── reading ───────────────────────────────────────────────────────────────────────────────────────────────────────
def get():
    B, P = _need()
    p = call("GET", f"/api/moodboards/{B}/video-projects/{P}")
    return (p["data"], p["version"]) if p else ({"channels": [], "clips": []}, 0)


def clips(d):
    return {c["id"]: c for c in d["clips"]}


def span(it):
    """the item's length on the timeline (s): source span / speed"""
    sp = it.get("speedPoints") or [{"y": 1}]
    return (it["trimEnd"] - it["trimStart"]) / (sp[0].get("y") or 1)


def walk(channels):
    for ch in channels:
        for it in ch["items"]:
            yield ch, it


def items(d):
    """yield (channel, item, start_s, end_s, clip) of the top level"""
    cl = clips(d)
    for ch, it in walk(d["channels"]):
        a = it.get("freeStart", 0.0)
        yield ch, it, a, a + span(it), cl.get(it.get("clipId"), {})


def sequences(d):
    for c in d["clips"]:
        if c.get("mediaType") == "sequence":
            yield c


def find(d, iid):
    """(channel, item) by id, top level first, then inside every sequence clip; (None, None) if absent"""
    for ch, it in walk(d["channels"]):
        if it["id"] == iid: return ch, it
    for c in sequences(d):
        for ch, it in walk(c["sequence"]["channels"]):
            if it["id"] == iid: return ch, it
    return None, None


def item(d, iid):
    ch, it = find(d, iid)
    if it is None: raise KeyError(iid)
    return it


def channel(d, name_or_id):
    for ch in d["channels"]:
        if ch["id"] == name_or_id or ch["name"] == name_or_id: return ch
    raise KeyError(name_or_id)


# ── writing helpers (use inside your fn) ──────────────────────────────────────────────────────────────────────────
def upsert(ch, it):
    """replace the item with the same id on this channel (or add it); the channel stays sorted by freeStart"""
    ch["items"] = [x for x in ch["items"] if x["id"] != it["id"]] + [it]
    ch["items"].sort(key=lambda x: x.get("freeStart", 0.0))


def upsert_clip(d, clip):
    d["clips"] = [c for c in d["clips"] if c["id"] != clip["id"]] + [clip]


def remove(d, ids):
    ids = set(ids)
    for ch in d["channels"]: ch["items"] = [x for x in ch["items"] if x["id"] not in ids]


def T(f):
    """start time of an item that must show from film frame f WITHOUT motion blur (0.5 ms early: starts round up)"""
    return round(f / FPS - 0.0005, 6)


def TB(n):
    """a boundary for frame n WITH motion blur on: the gap between two shutters (n/30 − 1/60); pull a video's
    trimStart back by speed/60 so the same source frame still shows"""
    return round(n / FPS - 1 / 60, 6)


def D(n, speed=1.0):
    """source span (s) of n film frames at speed"""
    return round(n / FPS * speed, 6)


def kf(*pts):
    """kf((pos %, value, easing), …) -> a propertyKeyframes track"""
    return [{"position": round(p, 4), "value": str(v), "easing": e} for p, v, e in pts]


# ── checks ────────────────────────────────────────────────────────────────────────────────────────────────────────
def _overlaps(channels, clip_list, lo, hi, tag="", kinds_skip=("audio", "null"), audio=False):
    bad = []; cl = {c["id"]: c for c in clip_list}
    for ch in channels:
        vis = []
        for it in ch["items"]:
            mt = cl.get(it.get("clipId"), {}).get("mediaType")
            if (mt != "audio") if audio else (mt in kinds_skip): continue
            a = it.get("freeStart", 0.0); b = a + span(it)
            if b > lo and a < hi: vis.append((a, b, it["id"]))
        vis.sort()
        for (a1, b1, i1), (a2, b2, i2) in zip(vis, vis[1:]):
            if a2 < b1 - 0.5 / FPS: bad.append((tag + ch["name"], i1, i2, round(a2 * FPS, 1), round(b1 * FPS, 1)))
    return bad


def overlaps(d, lo=0.0, hi=1e9, nested=True):
    """visual items overlapping on one channel in [lo, hi] s: (channel, item a, item b, from f, to f)"""
    bad = _overlaps(d["channels"], d["clips"], lo, hi)
    if nested:
        for c in sequences(d):
            bad += _overlaps(c["sequence"]["channels"], c["sequence"].get("clips", d["clips"]), 0, 1e9, tag=f"[{c['id']}] ")
    return bad


def audio_overlaps(d, lo=0.0, hi=1e9):
    """two audio items overlapping on one channel (the later one cuts the earlier)"""
    return _overlaps(d["channels"], d["clips"], lo, hi, audio=True)


def patch(fn, who, note, lo=0.0, hi=1e9, lo_f=None, hi_f=None, allow_overlap=False, ok_ids=(), tries=10):
    """GET → fn(fresh data) → overlap check in [lo, hi] (s, or lo_f/hi_f frames) → PUT expected_version; retries on 409.
    ok_ids: item ids whose known overlaps are tolerated (a neighbour another writer is rebuilding)."""
    B, P = _need()
    if lo_f is not None: lo = lo_f / FPS
    if hi_f is not None: hi = hi_f / FPS
    for k in range(tries):
        data, ver = get()
        d = copy.deepcopy(data)
        fn(d)
        if not allow_overlap:
            bad = [b for b in overlaps(d, lo, hi) if not ({b[1], b[2]} & set(ok_ids))]
            if bad: raise RuntimeError(f"overlapping items on one channel (ch, a, b, from f, to f): {bad}")
        try:
            r = call("PUT", f"/api/moodboards/{B}/video-projects/{P}", {"data": d, "expected_version": ver})
            os.makedirs(_C["work_dir"], exist_ok=True)
            with open(os.path.join(_C["work_dir"], "patch_log.jsonl"), "a") as f:
                f.write(json.dumps({"t": time.strftime("%Y-%m-%d %H:%M:%S"), "who": who, "note": note, "from": ver,
                                    "to": (r or {}).get("version"), "dry": _C["dry"]}) + "\n")
            return r
        except urllib.error.HTTPError as e:
            if e.code == 409: time.sleep(1.5 + k); continue
            raise
    raise RuntimeError("gave up after repeated 409s")


# ── renders ───────────────────────────────────────────────────────────────────────────────────────────────────────
def engine():
    """the app's render engine ("webgl" or "webgpu", GET /api/video-editor/engine); headless renders default to webgl"""
    try:
        return (call("GET", "/api/video-editor/engine") or {}).get("engine") or "webgl"
    except Exception:
        return "webgl"


def render(a, b, out, width=None, height=None, poll=3, renderer=None):
    """range render (seconds) with the full renderer as a background job, a unique file kept off the board; copied to
    <work_dir>/<out> (or out if absolute). Start ranges at n/30 (a range that starts between frames samples between them).
    width/height None = the project's own size. renderer None = the app's engine (GET /api/video-editor/engine), so the
    render draws what the editor shows ("webgl" | "webgpu").
    Render one job at a time: two at once each got a one-frame jump in a render-variance check."""
    B, P = _need()
    dst = out if os.path.isabs(out) else os.path.join(_C["work_dir"], out)
    os.makedirs(os.path.dirname(os.path.abspath(dst)), exist_ok=True)
    name = "seam_" + os.path.splitext(os.path.basename(out))[0] + "_" + str(int(time.time() * 1000) % 10 ** 8)
    body = {"format": "mp4", "fps": FPS, "rangeStart": a, "rangeEnd": b, "fileName": name, "saveToBoard": False,
            "renderer": renderer or engine()}
    if width and height: body.update(width=width, height=height)
    job = call("POST", f"/api/moodboards/{B}/video-projects/{P}/render-onserver-job", body)
    if job is None: return dst
    while True:
        j = call("GET", f"/api/video-render-jobs/{job['id']}")
        if j["status"] in ("completed", "failed", "cancelled"): break
        time.sleep(poll)
    if j["status"] != "completed": raise RuntimeError(f"render {j['status']}: {j.get('error')}")
    url = (j.get("result") or {}).get("url") or j.get("url")
    urllib.request.urlretrieve(url if url.startswith("http") else kitlib.base_url() + url, dst)
    return dst


def render_frames(f0, f1, out, **kw):
    """film frames f0…f1 inclusive: rangeEnd (f1 + 0.5)/30 (rangeEnd = N/30 returns one extra black frame)"""
    return render(f0 / FPS, (f1 + 0.5) / FPS, out, **kw)


def still(t, out):
    """/render-still at t seconds (hidden stash, never the board), saved to out"""
    B, P = _need()
    j = call("POST", f"/api/moodboards/{B}/video-projects/{P}/render-still", {"time": float(t), "format": "png", "saveToBoard": False}, timeout=300)
    if j is None: return out
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    open(out, "wb").write(base64.b64decode(j["dataUrl"].split(",", 1)[1]))
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    kitlib.add_config_arg(ap)
    ap.add_argument("--board"); ap.add_argument("--project"); ap.add_argument("--work-dir", dest="work_dir")
    ap.add_argument("--dry-run", action="store_true", help="print the API calls, make none")
    ap.add_argument("--project-json", help="read the project from this file (GET response or its data) instead of the API")
    sub = ap.add_subparsers(dest="cmd", required=True)
    g = sub.add_parser("get"); g.add_argument("--out")
    for n in ("overlaps", "dump"):
        s = sub.add_parser(n); s.add_argument("--lo-f", type=float, default=0); s.add_argument("--hi-f", type=float, default=1e9)
    r = sub.add_parser("render"); r.add_argument("f0", type=int); r.add_argument("f1", type=int); r.add_argument("out")
    r.add_argument("--width", type=int, help="default: the project's own size"); r.add_argument("--height", type=int)
    r.add_argument("--renderer", choices=("webgl", "webgpu"), help="default: the app's engine (GET /api/video-editor/engine)")
    s = sub.add_parser("still"); s.add_argument("time", type=float); s.add_argument("out")
    a = ap.parse_args()
    configure(board=a.board, project=a.project, work_dir=a.work_dir, config=a.config, dry=a.dry_run)
    if a.project_json:
        j = json.load(open(a.project_json)); d, ver = j.get("data", j), j.get("version")
    elif a.cmd in ("get", "overlaps", "dump"):
        d, ver = get()
    if a.cmd == "get":
        if a.out: kitlib.write_json(a.out, {"data": d, "version": ver}, indent=None); print("saved", a.out, "version", ver)
        else: print(json.dumps({"version": ver, "channels": len(d["channels"]), "clips": len(d["clips"])}))
    elif a.cmd == "overlaps":
        bad = overlaps(d, a.lo_f / FPS, a.hi_f / FPS)
        print(json.dumps({"visual_overlaps": bad, "audio_overlaps": audio_overlaps(d, a.lo_f / FPS, a.hi_f / FPS)}, indent=1))
        sys.exit(1 if bad else 0)
    elif a.cmd == "dump":
        for ch, it, s0, s1, c in items(d):
            if s1 * FPS > a.lo_f and s0 * FPS < a.hi_f:
                print(f"{ch['name'][:28]:28s} {it['id'][:22]:22s} f{s0 * FPS:7.1f}–f{s1 * FPS:7.1f}  {c.get('mediaType', '?'):8s} "
                      f"{(it.get('customName') or c.get('name') or '')[:40]}")
    elif a.cmd == "render":
        print(render_frames(a.f0, a.f1, a.out, width=a.width, height=a.height, renderer=a.renderer))
    elif a.cmd == "still":
        print(still(a.time, a.out))


if __name__ == "__main__":
    main()
