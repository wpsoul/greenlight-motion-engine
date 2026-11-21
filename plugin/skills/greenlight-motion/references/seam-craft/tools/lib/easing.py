#!/usr/bin/env python3
"""easing.py — the Video Editor's own keyframe easings and track evaluation, so offline checks see the same
in-between values the renderer draws.

The curves come from the editor itself: GET /api/video-editor/capabilities -> easings.keyframe.curves. A snapshot
ships beside this file (editor_easings.json) and loads on import; $SEAM_EASINGS (or the older $VRX_EASINGS) points to
a fresher copy, e.g. one saved with `fetch` into your work folder after an app update:
  easing.py fetch caps.json                      save the capabilities (needs the local board API, free)
  easing.py eval caps.json "Expo Out" 0.25        the eased value at u = 0.25
  easing.py track caps.json keys.json 37.5        a propertyKeyframes track's value at position 37.5 %
As a module: easing.load(caps_path); easing.ease(name, u, bezier=None); easing.track(keys, pos)

`Custom` plays the key's own `bezier` [x1, y1, x2, y2] (no bezier: `Smooth`, as the editor does). `Hold` steps at the
next key. An easing name the loaded curves don't know raises KeyError: a misspelt or newer name must not play as
Linear (load a newer capabilities copy). Split slices (`easeSlice`) are not evaluated here.
"""
import argparse, json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))   # tools/lib: kitlib sits beside this file
import kitlib  # noqa: E402

CURVES = {}


def load(path):
    kf = json.load(open(path))["easings"]["keyframe"]
    CURVES.clear(); CURVES.update({c["value"]: c for c in kf["curves"]})
    # names the editor retired still load in a saved project (Power2 Out -> Ease Out …): same curve as their replacement
    for old, new in (kf.get("retired") or {}).items():
        if old not in CURVES and new in CURVES: CURVES[old] = CURVES[new]


DEFAULT_EASINGS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "editor_easings.json")
_ENV_EASINGS = kitlib.env("EASINGS")
if _ENV_EASINGS and os.path.exists(_ENV_EASINGS): load(_ENV_EASINGS)
elif os.path.exists(DEFAULT_EASINGS): load(DEFAULT_EASINGS)   # the editor's curves shipped beside this file


def _bez(x1, y1, x2, y2, u):
    lo, hi = 0.0, 1.0
    for _ in range(40):
        t = (lo + hi) / 2
        x = 3 * (1 - t) ** 2 * t * x1 + 3 * (1 - t) * t ** 2 * x2 + t ** 3
        lo, hi = (t, hi) if x < u else (lo, t)
    t = (lo + hi) / 2
    return 3 * (1 - t) ** 2 * t * y1 + 3 * (1 - t) * t ** 2 * y2 + t ** 3


def ease(name, u, bezier=None):
    """eased progress at u (0…1) of a segment whose left key has easing `name` (and, for Custom, `bezier`)"""
    u = min(1.0, max(0.0, u))
    if name in (None, "", "Linear"): return u
    if name == "Hold": return 0.0 if u < 1 else 1.0
    if name == "Custom":
        if isinstance(bezier, (list, tuple)) and len(bezier) == 4:
            return _bez(*(float(x) for x in bezier), u)
        name = "Smooth"                                   # the editor's fallback for a Custom key without its bezier
    c = CURVES.get(name)
    if c is None:
        raise KeyError(f"unknown easing {name!r}: not in the loaded curves ({len(CURVES)} names); "
                       "load a newer capabilities copy (easing.py fetch, $SEAM_EASINGS)")
    if c.get("kind") == "sampled" and c.get("samples"):
        s = c["samples"]; x = u * (len(s) - 1); i = min(int(x), len(s) - 2)
        return s[i] + (s[i + 1] - s[i]) * (x - i)
    if c.get("cubicBezier"): return _bez(*c["cubicBezier"], u)
    raise KeyError(f"easing {name!r} has no curve in the loaded capabilities")


def track(keys, pos):
    """value of a propertyKeyframes track at position pos (0–100 % of the item); the easing sits on the left key"""
    ks = sorted(keys, key=lambda k: k["position"])
    if pos <= ks[0]["position"]: return float(ks[0]["value"])
    for a, b in zip(ks, ks[1:]):
        if pos <= b["position"]:
            u = (pos - a["position"]) / max(1e-9, b["position"] - a["position"])
            va, vb = float(a["value"]), float(b["value"])
            return va + (vb - va) * ease(a.get("easing"), u, a.get("bezier"))
    return float(ks[-1]["value"])


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    f = sub.add_parser("fetch"); f.add_argument("out")
    e = sub.add_parser("eval"); e.add_argument("caps"); e.add_argument("name"); e.add_argument("u", type=float)
    t = sub.add_parser("track"); t.add_argument("caps"); t.add_argument("keys"); t.add_argument("pos", type=float)
    a = ap.parse_args()
    if a.cmd == "fetch":
        kitlib.write_json(a.out, kitlib.call("GET", "/api/video-editor/capabilities")); print("saved", a.out)
    elif a.cmd == "eval":
        load(a.caps); print(round(ease(a.name, a.u), 6))
    else:
        load(a.caps); print(round(track(json.load(open(a.keys)), a.pos), 6))


if __name__ == "__main__":
    main()
