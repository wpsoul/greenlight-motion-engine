#!/usr/bin/env python3
"""carrier_box.py — measure a carrier on screen, frame by frame: the closed light (or dark) shape nearest a point.

  carrier_box.py RENDER.mp4 --frames F0-F1 [--mode light|dark] [--near X,Y] [--min-area 5000] [--close 15] [--json out.json]

A scene seam is built on something the picture already shows (a pill, a button, a card, a screen, a panel): to make a
window follow it, push into it or fly into it you need its box and centre in screen px per frame, including the drift
the shot gives it by itself. This finds, on every frame F0…F1 (film frames = render frames of a full render), the
connected region of light (low saturation, high value) or dark pixels that does not touch the frame edge, after a
morphological close that swallows the label written on it, and keeps the one nearest --near (default the centre).
Prints x0 x1 y0 y1 w h cx cy per frame; --json writes them for scenefx (point_of / center_of).
Check one frame by eye before trusting it (a gradient rim or a glow can merge two shapes: raise --close or the mode
thresholds). Needs OpenCV + numpy + ffmpeg on PATH.
Every frame is scaled to 1920×1080 before it is measured, so the box is in 1920×1080 px (the scenefx convention); a
render of another aspect (9:16) is stretched: convert the numbers yourself. --fps (default 30) is the render's rate;
--sat / --val (defaults 70 / 200) are the light mode's max saturation and min value (dark mode: value < 255 − val).
"""
import argparse, json, subprocess, sys
import numpy as np
import cv2


def frames(path, f0, f1, fps):
    w, h = 1920, 1080
    raw = subprocess.run(["ffmpeg", "-v", "error", "-ss", f"{f0 / fps:.4f}", "-i", path, "-frames:v", str(f1 - f0 + 1),
                          "-vf", f"scale={w}:{h}", "-f", "rawvideo", "-pix_fmt", "bgr24", "-"], check=True, capture_output=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(-1, h, w, 3)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("render"); ap.add_argument("--frames", required=True)
    ap.add_argument("--mode", choices=("light", "dark"), default="light")
    ap.add_argument("--near", default="960,540"); ap.add_argument("--min-area", type=int, default=5000)
    ap.add_argument("--close", type=int, default=15); ap.add_argument("--fps", type=float, default=30.0)
    ap.add_argument("--sat", type=int, default=70, help="light: max saturation"); ap.add_argument("--val", type=int, default=200,
                    help="light: min value; dark: max value is 255-val")
    ap.add_argument("--json")
    a = ap.parse_args()
    f0, f1 = map(int, a.frames.split("-")); nx, ny = map(float, a.near.split(","))
    out = {}
    for i, im in enumerate(frames(a.render, f0, f1, a.fps)):
        hsv = cv2.cvtColor(im, cv2.COLOR_BGR2HSV)
        m = ((hsv[..., 1] < a.sat) & (hsv[..., 2] > a.val)) if a.mode == "light" else (hsv[..., 2] < 255 - a.val)
        m = cv2.morphologyEx(m.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((a.close, a.close), np.uint8))
        n, lab, st, cen = cv2.connectedComponentsWithStats(m)
        H, W = m.shape; best, bd = None, 1e18
        for k in range(1, n):
            x, y, w, h, ar = st[k]
            if x <= 0 or y <= 0 or x + w >= W or y + h >= H or ar < a.min_area: continue
            dd = (cen[k][0] - nx) ** 2 + (cen[k][1] - ny) ** 2
            if dd < bd: best, bd = k, dd
        f = f0 + i
        if best is None:
            print(f"f{f}  none"); out[f] = None; continue
        x, y, w, h, _ = st[best]; cx, cy = x + w / 2, y + h / 2
        print(f"f{f}  x {x}–{x + w}  y {y}–{y + h}  w {w}  h {h}  centre ({cx:.0f}, {cy:.0f})")
        out[f] = {"x0": int(x), "x1": int(x + w), "y0": int(y), "y1": int(y + h), "w": int(w), "h": int(h), "cx": cx, "cy": cy}
    if a.json: json.dump(out, open(a.json, "w"), indent=1)


if __name__ == "__main__":
    main()
