#!/usr/bin/env python3
"""seam_compare.py — show WHERE versions of a film differ and let the user SEE it.

  seam_compare.py diff BASE.mp4 OTHER.mp4 [OTHER2.mp4 …] [--thr 3] [--json out.json]
      frame ranges where each OTHER differs from BASE (mean abs difference of a 160×90 grey copy > thr levels) and the
      total seconds that changed. Run it before you report a version: a smoothing pass often changes only ~2 s of a
      1-minute film, which nobody notices at full speed. A part that must stay frozen (an approved opening, the
      music bed) shows no range; the tool lists ranges only, so check those spans yourself.

  seam_compare.py video --sources A.mp4,B.mp4,C.mp4 --labels "A · …","B · …","C · …" --windows windows.json
                  --out compare.mp4 [--slow 2] [--fps 30] [--font PATH] [--foot TEXT]
      a 2×2 film of the changed joins only: three versions + a notes panel (the join's title and one line per version),
      slowed (default 2×), no sound, the film frame counter on the first panel. windows.json:
      [{"f0": 410, "f1": 452, "title": "1 · … · 14.0 s", "lines": ["A: …", "B: …", "C: …"]}, …]  (film frames)
      Two sources work too (the fourth panel stays the notes, the third is left empty).

      --foot: the notes panel's footer line (default "0.5× · no sound"). --fps: the films' frame rate (default 30).
      --font: a TTF for the labels; without it the first that exists of ~/Library/Fonts/Inter-Regular.ttf, macOS
      Arial, Linux DejaVu Sans is used, and the tool stops with a message when none exists.

Needs ffmpeg (with drawtext for `video`) on PATH + numpy. The labels and notes are the reader's language.
"""
import argparse, json, os, subprocess, sys, tempfile
import numpy as np

FONTS = [os.path.expanduser("~/Library/Fonts/Inter-Regular.ttf"), "/System/Library/Fonts/Supplemental/Arial.ttf",
         "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"]


def grey(path, w=160, h=90):
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-vf", f"scale={w}:{h},format=gray", "-f", "rawvideo", "-"],
                         check=True, capture_output=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(-1, h, w).astype(np.float32)


def ranges(mask, gap=4):
    out, i, n = [], 0, len(mask)
    while i < n:
        if mask[i]:
            j = i
            while j + 1 < n and (mask[j + 1] or mask[j + 1:j + 1 + gap].any()): j += 1
            out.append((i, j)); i = j + 1
        else: i += 1
    return out


def cmd_diff(a):
    base = grey(a.base); res = {}
    for o in a.others:
        g = grey(o); n = min(len(base), len(g))
        d = np.abs(base[:n] - g[:n]).mean(axis=(1, 2))
        rs = ranges(d > a.thr)
        tot = sum(j - i + 1 for i, j in rs)
        print(f"{os.path.basename(o)} vs {os.path.basename(a.base)}: {tot} frames differ ({tot / a.fps:.1f} s of {n / a.fps:.1f} s)"
              + (f"; lengths differ ({len(base)} vs {len(g)} f)" if len(base) != len(g) else ""))
        for i, j in rs:
            print(f"   f{i}–{j}  ({i / a.fps:.2f}–{j / a.fps:.2f} s, {j - i + 1} f)  max Δ {d[i:j + 1].max():.1f}")
        res[o] = {"frames": tot, "ranges": [[i, j, round(float(d[i:j + 1].max()), 1)] for i, j in rs]}
    if a.json: json.dump(res, open(a.json, "w"), indent=1)


def cmd_video(a):
    srcs = a.sources.split(","); labs = [s.strip() for s in a.labels.split(",")]
    assert len(srcs) == len(labs) and 2 <= len(srcs) <= 3, "2 or 3 sources, one label each"
    font = a.font or next((f for f in FONTS if os.path.exists(f)), None)
    if not font or not os.path.exists(font):
        sys.exit("seam_compare video: no font found" + (f" at {a.font}" if a.font else f" (tried {', '.join(FONTS)})")
                 + ": pass --font /path/to/a.ttf")
    wins = json.load(open(a.windows)); tmp = tempfile.mkdtemp(prefix="seamcmp_")
    for k, l in enumerate(labs): open(f"{tmp}/lab{k}.txt", "w").write(l)
    open(f"{tmp}/foot.txt", "w").write(a.foot)
    parts = []
    for n, w in enumerate(wins):
        f0, f1 = int(w["f0"]), int(w["f1"]); dur = (f1 - f0 + 1) / a.fps; sl = a.slow
        open(f"{tmp}/t{n}.txt", "w").write(w["title"]); open(f"{tmp}/b{n}.txt", "w").write("\n".join(w.get("lines", [])))
        fc = []
        for k in range(len(srcs)):
            tc = (f",drawtext=fontfile={font}:text='f %{{eif\\:{f0}+t*{a.fps:g}\\:d}}':x=20:y=h-50:fontsize=24:fontcolor=white"
                  f":box=1:boxcolor=black@0.55:boxborderw=8") if k == 0 else ""
            fc.append(f"[{k}:v]scale=960:540,setsar=1,drawtext=fontfile={font}:textfile={tmp}/lab{k}.txt:x=20:y=20:fontsize=30"
                      f":fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=10{tc},setpts={sl}*PTS[p{k}]")
        if len(srcs) == 2:
            fc.append(f"color=c=0x0f1218:s=960x540:r={a.fps:g}:d={dur * sl:.4f}[p2]")
        fc.append(f"color=c=0x0f1218:s=960x540:r={a.fps:g}:d={dur * sl:.4f},drawtext=fontfile={font}:textfile={tmp}/t{n}.txt"
                  f":x=40:y=50:fontsize=34:fontcolor=0x22c55e,drawtext=fontfile={font}:textfile={tmp}/b{n}.txt:x=40:y=130"
                  f":fontsize=27:fontcolor=0xdbe4f5:line_spacing=14,drawtext=fontfile={font}:textfile={tmp}/foot.txt:x=40"
                  f":y=h-60:fontsize=22:fontcolor=0x8b909c[p3]")
        fc.append(f"[p0][p1][p2][p3]xstack=inputs=4:layout=0_0|w0_0|0_h0|w0_h0,fps={a.fps:g},format=yuv420p[v]")
        seg = f"{tmp}/seg{n}.mp4"; cmd = ["ffmpeg", "-v", "error", "-y"]
        for s in srcs: cmd += ["-ss", f"{f0 / a.fps:.4f}", "-t", f"{dur:.4f}", "-i", s]
        cmd += ["-filter_complex", ";".join(fc), "-map", "[v]", "-an", "-c:v", "libx264", "-crf", "18", "-preset", "fast",
                "-t", f"{dur * sl:.4f}", seg]
        subprocess.run(cmd, check=True); parts.append(seg)
    open(f"{tmp}/list.txt", "w").write("".join(f"file '{p}'\n" for p in parts))
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", f"{tmp}/list.txt", "-c", "copy",
                    "-movflags", "+faststart", a.out], check=True)
    print(a.out)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sp = ap.add_subparsers(dest="cmd", required=True)
    d = sp.add_parser("diff"); d.add_argument("base"); d.add_argument("others", nargs="+")
    d.add_argument("--thr", type=float, default=3.0); d.add_argument("--fps", type=float, default=30.0); d.add_argument("--json")
    v = sp.add_parser("video"); v.add_argument("--sources", required=True); v.add_argument("--labels", required=True)
    v.add_argument("--windows", required=True); v.add_argument("--out", required=True)
    v.add_argument("--slow", type=float, default=2.0); v.add_argument("--fps", type=float, default=30.0)
    v.add_argument("--font"); v.add_argument("--foot", default="0.5× · no sound")
    a = ap.parse_args()
    cmd_diff(a) if a.cmd == "diff" else cmd_video(a)


if __name__ == "__main__":
    main()
