> **Use this only when you can run Python on this computer; in a chat without a computer, follow the rules in [video-design.md](../video-design.md#motion-grammar) and skip this.**

# `seam_check.py` — checking every seam of a render

`seam_check.py` reads a rendered video, whatever made it. Units: [Seam Craft's](README.md#units); its px thresholds
are for a 1920-wide frame and scale with the render width.

```
seam_check.py RENDER.mp4 [--project-json P.json] [--seams auto|f1,f2,…] [--out DIR]
              [--anchor F:x,y,w,h …] [--mask x,y,w,h …] [--film-offset N] [--no-sheets]
```

`--anchor` and `--mask` repeat. `--film-offset` is the film frame of the render's frame 0 (a range render), so the
report's film frames line up with the film. `--project-json` reads a project file to add its layer boundaries as
soft seams; today it reads Video Editor projects ([In the Video Editor](#in-the-video-editor)). `--no-sheets` skips
the image sheets.
Setup and the other tools: [tools/README.md](tools/README.md).

## What it measures

For each seam frame F (the first frame of the incoming shot):

| Metric | How | Pass band (defaults) |
|---|---|---|
| `out` vector | global motion of the picture on frames F−3…F−1 (pairs inside the out shot only): LK corners + RANSAC similarity → vx, vy (px/f), zoom (%/f), rotation (°/f) | — |
| `in` vector | the same on F…F+2 (pairs inside the in shot only) | — |
| `dir_cos` | cosine between out and in pan vectors (when both ≥ 1.5 px/f) | ≥ 0.7 |
| `zoom_same_sign` | both zoom rates ≥ 0.15 %/f and the same sign | true when the seam is a zoom seam |
| `ratio` | \|in\| / \|out\| (pan) or rate_in / rate_out (zoom) | pan 0.8–1.5 · zoom 1.0–2.4 (outside the band but within 0.5–3: WARN) |
| `peak_offset` | frame of max speed within F−10…F+10, minus F | −2…+2 (WARN ±3–4) |
| `stop_start` | out speed on F−1 < 25 % of the out side's peak over F−12…F−1, or in speed on F < 25 % of its peak over F…F+12 | false |
| `still_side` | a side whose speed is < 0.3 px/f and < 0.1 %/f zoom for its 6 frames next to the seam | false (or the seam needs an anchor / dissolve) |
| `too_sharp` | a hard cut with a `still_side`, and a luma jump ≥ 60 levels or an incoming frame of mean luma < 20 (near-black) | false |
| `holds` | identical consecutive frames (mean abs diff < 0.4) within ±8 f — dead frames, stutter | none |
| `anchor_dx` | optional `--anchor F:x,y,w,h`: the patch template-matched across the seam (multi-scale) → centre Δ px, scale | ≤ 30 px, ×0.95–1.3 |

The pass bands are wider than the aim of [match-velocity.md](match-velocity.md) (pan ×1.0–1.3, zoom ×1.2–2.0): build to
the aim, accept the band.

The motion is measured on a 640-px-wide grey copy, blurred lightly; global motion ignores small moving layers (a
cursor) through RANSAC, while a large layer moving fast over a still background counts as the picture's motion. On
flat graphic frames with too few corners, phase correlation is the fallback (pan only), and the row says
`method: phase`.

## Which seams

- `--seams auto` (default): hard cuts from HSV-histogram correlation + SSIM (frame unlike its predecessor while its
  successors are alike), plus the motion-matched cuts the histograms miss (a one-row jump, no fit, a collapse of the
  tracked points), plus — with `--project-json` — every top-level layer boundary and cross-transition midpoint of the
  project (soft seams the histogram misses).
- `--seams 120,348,…`: exact frames, in render frames.
- Seams closer than 4 frames to the start or 3 to the end of the render are dropped.

## Verdict

- `PASS` — a moving seam with the same direction, ratio in band and peak within ±2; or an anchored seam with
  `anchor_dx` in band; or a dissolve between two moving sides.
- `WARN` — one number just outside its band (a ratio outside the band but within 0.5–3, peak ±3–4, dir_cos 0.4–0.7),
  or no move on either side and no anchor.
- `FAIL` — reversed direction, stop_start, too_sharp, holds at the seam, ratio < 0.5 or > 3, peak beyond ±4 f, an
  `--anchor` outside its band.

Each FAIL names the likely fix: re-solve the handles (ratio / peak), a landing or exit move (still side), a different
SR type (reversed direction), remove the hold (holds), keep the anchor's centre and size (anchor). The fix text names
the Video Editor's solver commands; in another tool, do the same with [match-velocity.md](match-velocity.md#solving-one-seam).

The verdict is for moving seams (SR-01 / 02 / 06 / 09). The other types have their own checks in
[seam-recipes.md](seam-recipes.md#read-the-verdicts-by-seam-type).

### Known false verdicts (read the per-row speeds before acting on a FAIL)

Found on real films. Judge these by hand:

- **Blurred type:** LK under-reads a motion-blurred word (−53…−80 px/f on a word whose keys run −360 px/f) and is not
  repeatable on identical frames. Take the speed from the layer's keys instead.
- **One accelerating curve under a dissolve:** 3-row means on both sides of a continuous ease-in exit always differ
  (×1.5–2.6, "peak +6"), and `stop_start` fires on the acceleration alone. If the `speeds` rows show no step
  (e.g. −10, −14, −20, −26 | −35, −44, −56 px/f), the seam is continuous: report it as such.
- **Dissolve rows tagged as hard cuts:** a frame inside a layer's own opacity ramp can be detected as a cut. Judge it
  by the luma ramp (largest one-frame step; a pop is ≥ 60 levels).
- **Luma pops when both sides move:** `too_sharp` can miss a light → black jump (Δ150) when both sides have motion.
  Check the largest one-frame luma step at every join yourself (the `luma` pair of each record).

## Output

In `--out DIR` (default `<render>_seams/` beside the render):
- `seams.json` — the run's settings (size, fps, film offset, thresholds, units), a summary, and one record per seam
  with every metric, the per-frame speeds F−12…F+12 (`speeds`), `film_f` and `t`, the verdict, its fails/warns and fix;
- `SEAMS.md` — the table: seam · time · type guess · out → in · ratio · peak · dir · verdict · fix, and a summary line;
- `sheets/seam_FFFF.jpg` — frames F−3…F+3 (F as 4 digits, render frames), motion arrows drawn (green pan, blue zoom),
  F ringed.

It also prints one line per seam and the summary; the exit code is 0, so read the verdicts.

## Calibration

`examples/reference_film_seams.json` holds the reference film's measured numbers only (no render ships with it). On
that film the tool reported direction kept at about 30 of the 37 seams and the peak within ±2 f at about 29. Use its
records (speeds, ratios, seam lengths) as the expected range for a crafted film, not as a test you can re-run.

## In the Video Editor

- `seam_check.py RENDER --project-json P.json` takes a project GET (or its `data`) and adds every top-level item
  boundary and cross-transition midpoint as a soft seam (audio, camera, null and adjustment items are skipped). With a
  range render pass `--film-offset` so the project's times line up.
- Render ranges with `tools/lib/vp.py render` (film frames F0…F1, `rangeEnd = (F1 + 0.5) / 30`: N/30 returns one extra
  black frame). Render one job at a time.
- Take a layer's real speed from its keys (`seam_fit.py inspect --item ITEM --at-frame F`) when `seam_check`
  under-reads blurred type.
- Two renders of the same data can differ in small spots inside embedded screen videos: measure that noise floor once.
- Render time: on ~850 items a 30–85-frame range rendered in 13–19 s and a full minute in 1–1.5 min, so plan 6–10
  range tries.

## In HyperFrames

HyperFrames' own checks come first (hyperframes.md (GreenLight Dash only)); then, in
the project folder:

```
# the seam frames: every scene host's start × fps (30 here)
npx hyperframes timeline --json | jq -r '[.timeline.tracks[].rows[] | select(.src != null and .absStart > 0)
  | .absStart * 30 | round] | sort | map(tostring) | join(",")'

SC="<the board skill folder>/references/video/seam-craft/tools"
~/.venvs/seam-craft/bin/python "$SC/seam_check.py" work/film.mp4 --seams 90,210 --out work/seams
```

- **Which seams.** `--seams auto` finds hard cuts by itself. Overlapping scenes (a window, a dissolve) need their frames
  listed: the incoming host's start and the outgoing host's end. `--project-json` reads Video Editor projects only.
- **A range.** The current HyperFrames docs' `render --start S --end E` writes an MP4 of that span starting at 0; then
  pass `--film-offset` = S × 30 ([cli.mdx](https://github.com/heygen-com/hyperframes/blob/main/docs/packages/cli.mdx)).
  CLI 0.8.212 has no range flag: render the whole film (a 4.5-s test took ~6 s) and pass film frames.
- **Blurred type under-reads** ([Known false verdicts](#known-false-verdicts-read-the-per-row-speeds-before-acting-on-a-fail)):
  take that layer's speed from the tween's maths instead.
- **Then the other checks:** the 2-f contact sheet of every join ([tools/README.md](tools/README.md#contact-sheet)), the
  scene-seam checks ([scene-seams.md](scene-seams.md#checks)), and the recipe checks for the types `seam_check` doesn't
  judge ([read the verdicts by seam type](seam-recipes.md#read-the-verdicts-by-seam-type)).

## In code: a page rendered frame by frame, clips joined with ffmpeg

`$PY` is the tools' Python (`~/.venvs/seam-craft/bin/python`), `$SC` this folder's `tools/`; the renderer and the
commands are in [video-motion-in-code.md](../video-motion-in-code.md#render-frame-by-frame).

```
$PY "$SC/seam_check.py" work/film.mp4 --seams 90 --out work/seams       # the cut frames are in your code: CUT × fps

node render.mjs film.html work/range 1 30 2.5                           # a range: film frames 75…104
ffmpeg -framerate 30 -i work/range/f_%05d.png -c:v libx264 -crf 16 -pix_fmt yuv420p work/range.mp4
$PY "$SC/seam_check.py" work/range.mp4 --seams 15 --film-offset 75 --out work/range_seams
```

- **Which seams.** `--seams auto` finds hard cuts; list the soft ones yourself (an `xfade`'s first and last frame, a
  window's span). `--project-json` reads Video Editor projects only.
- **A range** needs no replay with a pure `draw(t)`: the range's frame 14 was byte-identical to film frame 89 here.
- **A cut on the peak between two clips.** Read both clips' motion profiles, `$PY "$SC/film_profile.py" A.mp4 a.json`
  and the same for B (rows f, vx, vy, zoom, luma; row f = the move from frame f−1 to f): the out point p is the frame
  whose row is A's peak speed, the rows before it still rising; the in point q is a frame of B whose next rows (q+1,
  q+2) move the same way at 1.0–1.3 × A's row p. Join them as in
  [video-motion-in-code.md](../video-motion-in-code.md#a-cut-on-the-peak-sr-01), then `$PY "$SC/seam_check.py" join.mp4 --seams 31
  --out work/seams` (the seam = the number of A's frames kept). Tested on two 2-s clips whose moves peak at frame 30:
  cut there, PASS at ratio 1.23; the same clips butted whole (both at rest at the join), FAIL `stop_start`.
- **A slide timed to a pan** (`xfade` `slideleft`) starts and stops at full speed, a step at each end: measure both
  with `seam_check --seams <o × fps>,<(o + d) × fps>`.
- **Then the other checks:** the 2-f contact sheet of every join ([tools/README.md](tools/README.md#contact-sheet)), the
  scene-seam checks ([scene-seams.md](scene-seams.md#checks)), and the recipe checks for the types `seam_check` doesn't
  judge ([read the verdicts by seam type](seam-recipes.md#read-the-verdicts-by-seam-type)).
