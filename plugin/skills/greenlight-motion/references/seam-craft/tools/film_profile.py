#!/usr/bin/env python3
"""film_profile.py RENDER OUT.json [--plot OUT.png] [--marks F1,F2,…] — per-frame global motion of a whole render, using
seam_check's own scan() (so numbers match the tool). Rows: f, vx, vy (px/f), zoom (%/f), luma, mad, cut, method.
--plot draws pan speed, |zoom| and luma per frame (cuts as red ticks); --marks adds magenta lines at those frames
(e.g. your planned joins). Needs OpenCV + numpy."""
import sys, json, os, argparse
T = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, T)
import seam_check as sc
ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
ap.add_argument("render"); ap.add_argument("out"); ap.add_argument("--plot", help="a PNG of the profile")
ap.add_argument("--marks", default="", help="comma-separated frames to mark on the plot")
a = ap.parse_args()
rows, fps, W, H, me = sc.scan(a.render, [])
keep = [{k: r.get(k) for k in ("f", "vx", "vy", "zoom", "luma", "mad", "cut", "method")} for r in rows]
json.dump({"W": W, "H": H, "fps": fps, "rows": keep}, open(a.out, "w"))
if a.plot:
    import numpy as np, cv2, math
    n = len(keep); Wp, Hp = 3200, 700
    img = np.full((Hp, Wp, 3), 255, np.uint8)
    def X(f): return int(40 + f / n * (Wp - 60))
    sp = [math.hypot(r["vx"] or 0, r["vy"] or 0) if r.get("vx") is not None else 0 for r in keep]
    zm = [abs(r["zoom"] or 0) if r.get("zoom") is not None else 0 for r in keep]
    lu = [r["luma"] for r in keep]
    for f in range(0, n, 30):
        cv2.line(img, (X(f), 0), (X(f), Hp), (225, 225, 225), 1)
        cv2.putText(img, f"{f}", (X(f) + 2, Hp - 6), 0, 0.4, (120, 120, 120), 1)
    for f in range(1, n):
        cv2.line(img, (X(f - 1), int(300 - min(sp[f - 1], 280))), (X(f), int(300 - min(sp[f], 280))), (200, 60, 0), 2)
        cv2.line(img, (X(f - 1), int(500 - min(zm[f - 1] * 20, 190))), (X(f), int(500 - min(zm[f] * 20, 190))), (0, 120, 0), 2)
        cv2.line(img, (X(f - 1), int(690 - lu[f - 1] * 0.7)), (X(f), int(690 - lu[f] * 0.7)), (120, 120, 120), 1)
        if keep[f].get("cut"): cv2.line(img, (X(f), 0), (X(f), 20), (0, 0, 255), 3)
    for m in [x for x in a.marks.split(",") if x]:
        cv2.line(img, (X(int(m)), 0), (X(int(m)), Hp), (255, 0, 255), 1)
    cv2.putText(img, "blue: pan px/f (0-280)   green: |zoom| %/f x20   grey: luma   red ticks: cuts", (50, 20), 0, 0.6, (0, 0, 0), 1)
    cv2.imwrite(a.plot, img)
print("rows", len(keep))
