> **GreenLight Motion Engine:** Seam Craft as GreenLight Dash's agents have it, for the films the engine makes,
> and only where Python 3 with OpenCV runs on this computer (in a chat, the rules in [video-design.md](../../video-design.md#motion-grammar)
> alone). `seam_check.py`, `carrier_box.py`, `seam_compare.py`, `film_profile.py` and `keyfit.py curve` / `moves` read a render
> (`npx greenlight-motion render`) or a curve; `keyfit.py check` / `thin` and `glpath.py check` read the engine's `project.json`.
> `seam_fit.py`, `vp.py`, `scenefx.py` and `kitlib.py` edit and render a project through the GreenLight Dash board API:
> GreenLight Dash only; here you write the keys their recipes give into `project.json` (`apply`). In this package the folder is
> `skill/references/seam-craft/`: copy `tools/` into your work folder and run the copy.

> **Use this only when you can run Python on this computer; in a chat without a computer, follow the rules in [video-design.md](../../video-design.md#motion-grammar) and skip this.**

# Seam Craft tools

Each tool is marked by what it works on: **any video** (it reads rendered files, whatever made them) or **GLEA
projects** (it reads or writes a project of the GreenLight Dash Video Editor through the board API; the editor's
fields at a join are in [video-transitions.md](../../video-transitions.md#joins-in-the-editor-the-fields-of-the-motion-grammar)).

| Tool | Works on | Does |
|---|---|---|
| `seam_check.py` | any video (`--project-json`: a GLEA project) | finds every seam of a render and checks it by numbers |
| `carrier_box.py` | any video | measures a carrier's box and centre per frame |
| `seam_compare.py` | any video | where versions differ; a slowed 2×2 film of the changed joins |
| `film_profile.py` | any video | the whole-film motion profile (rig films) |
| `lib/keyfit.py curve` | any curve | a dense curve as the fewest eased keys ([below](#keyfitpy--motion-as-the-fewest-eased-keys)) |
| `seam_fit.py` | GLEA projects | match velocity: rewrites the keys at a join in the live project |
| `lib/scenefx.py` | GLEA projects | scene-seam building blocks on a project's data, written as a few eased keys |
| `lib/vp.py` | GLEA projects | safe versioned edits and range renders |
| `lib/rig.py` | GLEA projects | evaluates a WORLD-null rig and projects it to the screen |
| `lib/keyfit.py moves` | measured tracks | a tracked layer as moves: smoothed at its noise, 2 keys and one ease per move ([video-design.md](../../video-design.md#computed-and-measured-motion-fit-it-then-write-it)) |
| `lib/keyfit.py check` / `thin` | GLEA projects | finds and thins tracks keyed frame by frame, and lists the keys that STOP or JOLT a move that goes on: run `check --strict` before delivery |
| `lib/glpath.py corner` / `check` | GLEA projects | lines with corners as straight legs and one radius; finds hooked corners and leaning legs |
| `lib/easing.py`, `lib/timeline.py`, `lib/kitlib.py` | GLEA projects | the editor's curves, where items sit, API calls (shared helpers) |

## Setup

The tools need Python 3 with `opencv-python` and `numpy` (`scipy` too, for `lib/keyfit.py`'s handle refit), and
`ffmpeg` on PATH (`carrier_box.py` and `seam_compare.py` call it; `seam_compare.py video` needs its `drawtext`
filter). A system `python3` usually has none of these, so make a venv once:

```
python3 -m venv ~/.venvs/seam-craft
~/.venvs/seam-craft/bin/pip install opencv-python numpy scipy
ffmpeg -version                  # missing: install it (e.g. brew install ffmpeg)
```

Run the tools with that Python and the quoted path to this folder. Inside the GreenLight Dash app it is
`<greenlight-dash skill>/references/video/seam-craft/tools`, a path with spaces.

```
SC="<greenlight-dash skill>/references/video/seam-craft/tools"
export PYTHONDONTWRITEBYTECODE=1           # keep the skill folder clean (read-only inside the app)
~/.venvs/seam-craft/bin/python "$SC/seam_check.py" work/render.mp4 --out work/seams
```

Inside the app, workflows that measure joins install their own OpenCV Python (`~/.greenlight-motion/cv-venv`) and say
so: use theirs instead of making this venv.

Write outputs to your work folder, never into this one. To change a tool, copy `tools/` into your work folder and run
the copy. `lib/vp.py` and `lib/easing.py fetch` run on the standard library alone; `lib/scenefx.py` needs numpy, as
it fits its keys with `lib/keyfit.py`.

Everything is local; the only network is the board API at `$GREENLIGHT_API_BASE_URL` (set by the GreenLight Dash
terminal; `$GREENLIGHT_API_TOKEN` is sent when set). `seam_check`, `carrier_box`, `seam_compare` and `film_profile`
only read files. `seam_fit` (match/land/exit) and `lib/vp.py` write the project, and `vp.py render` / `still` start
renders.

**Assumptions.** 30 fps and a 16:9 1920×1080 project, unless a flag says otherwise:
- `lib/vp.py` sends render jobs at 30 fps and counts frames as n/30; `lib/scenefx.py` (FPS, W, H, the centre C) and
  `lib/rig.py` (960/540, P = 2166) are written for 30 fps 1920×1080; `carrier_box.py` scales every frame to 1920×1080
  before measuring (a 9:16 render is stretched).
- `seam_check.py` reads the render's own fps and size (px thresholds scale ×W/1920); `seam_fit.py`, `carrier_box.py`,
  `seam_compare.py` and `keyfit.py` take `--fps`; `seam_fit.py` reads the project's `videoSize`.
- For a 60 fps or 9:16 film, convert the numbers, use the tools that adapt, or copy the others and change their
  constants.

**Environment variables** (`$VRX_…` spellings are read too):

| Variable | Used by |
|---|---|
| `$SEAM_BOARD`, `$SEAM_PROJECT` | the board and project id for `seam_fit.py` and `lib/vp.py` when no flag is given |
| `$SEAM_WORK` | the work folder: `lib/vp.py` logs and range renders, `seam_fit.py --work` default |
| `$SEAM_CONFIG` | a JSON with `board`, `project`, `work_dir` (`lib/vp.py --config` default) |
| `$SEAM_EASINGS` | a capabilities copy for `lib/easing.py` instead of the shipped `lib/editor_easings.json` |

## `seam_check.py` — any video: every seam of a render, by numbers (spec: [../seam-check.md](../seam-check.md))

```
seam_check.py RENDER.mp4 [--project-json P.json] [--seams auto|f1,f2,…] [--out DIR]
              [--anchor F:x,y,w,h …] [--mask x,y,w,h …] [--film-offset N] [--no-sheets]
```
- **Seams:** `auto` (default) = hard cuts (histogram + SSIM, plus motion-matched cuts the histograms miss: a one-row
  jump, no fit, a collapse of tracked points) and, with `--project-json` (a project GET or its `data`), every top-level
  item boundary and cross-transition midpoint. Or exact frames: `--seams 120,348` (render frames, F = first frame in).
- **Measures** per seam: `out` (rows F−3…F−1) and `in` (rows F…F+2 without the cut pair) global motion — vx, vy px/f
  (render px), zoom %/f, rotation — from LK + RANSAC similarity on a 640-px copy (phase correlation on flat frames; a
  large layer moving fast over a still background counts as the picture's motion); `dir_cos`, `zoom_same_sign`,
  `ratio`, `peak_offset`, `stop_start`, `still_side`, `too_sharp`, `holds`, `anchor_dx`.
- **Verdict** PASS / WARN / FAIL, each FAIL with its fix (`seam_fit match`, `seam_fit land|exit`, another SR type, remove
  the hold, keep the anchor). px thresholds are for 1920 wide and scale with the render.
- **Out:** in `--out DIR` (default `<render>_seams/`): `seams.json` (all metrics, per-frame speeds F−12…F+12,
  `film_f`), `SEAMS.md`, `sheets/seam_FFFF.jpg` (F as 4 digits; F−3…F+3, arrows: green pan, blue zoom; F ringed).
  `--film-offset` = the film frame of render frame 0 (range renders). `--anchor` and `--mask` repeat; `--mask` hides a
  static watermark from the motion measure. Exit code 0: read the verdicts.

## `seam_fit.py` — GLEA projects: match velocity in the live project (spec: [../match-velocity.md](../match-velocity.md#in-the-video-editor))

```
seam_fit.py inspect --item ITEM [--track T] [--at-frame F]
seam_fit.py match   --seams seams.json --seam F [--in ITEM:TRACK] [--out ITEM:TRACK]
                    [--ratio 1.2] [--out-slope 3] [--out-velocity V] [--soft-landing]
seam_fit.py land    --seam F --in ITEM:TRACK  (--velocity V | --from-seams seams.json) [--frames L] [--easing E] [--ratio 1.2]
seam_fit.py exit    --seam F --out ITEM:TRACK (--velocity V | --from-seams seams.json) [--frames L] [--easing E] [--ratio 1.2]
every command:      [--board B] [--project P] [--work DIR] [--fps 30] [--dry-run]
```
`--board`/`--project` default to `$SEAM_BOARD`/`$SEAM_PROJECT`, `--work` (logs) to `$SEAM_WORK` or the current folder.
`ITEM` is an item id, `SEQ_ITEM/ITEM` inside sequences, `camera:TRACK` the camera clip covering the seam
(`SEQ_ITEM/camera:TRACK` for a sequence's own camera). `--seam F` is a FILM frame. A layer on a live motion path is
matched on `ITEM:motionPathT`, its progress track.

- `inspect` — segments in film frames, easings, E'(0)/E'(1), start/end velocity in track units/f; with `--at-frame`
  the value and velocity of every frame F−12…F+12 (for a camera pass an `--at-frame` inside its clip). It names a
  camera mode that overrides keys. For an item on a live motion path it adds, on the `motionPathT` rows, where the
  layer is on screen and its speed in px/f.
- `match` — needs `--in` and/or `--out`. `--out`: the last segment before the seam gets an accelerating end (Custom
  bezier, end slope `--out-slope` 3 or the speed `--out-velocity` V in screen units); `--in`: the first segment after
  it starts at `--ratio` × the out speed (start handle solved so the rows seam_check reads hit the target), values,
  positions and the landing handle kept. Track → screen factor k is fitted on the measured rows (camera tracks come
  out negative), else taken from the units. Prints before/after handles and the predicted out/in speeds. On
  `motionPathT` the axis (vx or vy) and the px per % come from the path at the seam, and the predicted speed is
  walked along the path itself. `--soft-landing` also ends the in segment at rest (end handle 0.5, 1): for a layer
  that enters moving and stays in the shot. Without it a segment that was `Linear` stops dead at its last key, and
  the plan says so.
- `land` / `exit` — a static side gets a short move (`--frames` L: default 15 f pan, 20 f zoom; `--easing` default
  `Cubic Out` / `Cubic In`) whose seam rows move at V (track units/f; zoom tracks log units/f) or at the other side's
  measured speed × / ÷ `--ratio`.
- **Camera modes:** it refuses `camZoom`/`camX`/`camY` under Smart Zoom and `camX`/`camY`/`camDolly` under a Camera
  Rig (those keys render as nothing), and warns for a path or an aimed rig: set the camera's `"cameraMoveMode":
  "free"` first ([the camera at a join](../../video-transitions.md#the-camera-at-a-join)).
- Every write: `lib/vp.py` patch (GET → change computed on that fresh data → PUT `expected_version`, a 409 reruns it),
  `<work>/seam_fit_log.jsonl` and `<work>/patch_log.jsonl`, other fields kept. Then render the range and check it:
  `lib/vp.py --board B --project P render F−20 F+20 out.mp4`, `seam_check.py out.mp4 --seams 20 --film-offset F−20`.

## `carrier_box.py` — any video: measure a carrier on screen (spec: [../scene-seams.md](../scene-seams.md))

```
carrier_box.py RENDER.mp4 --frames F0-F1 [--mode light|dark] [--near X,Y] [--min-area 5000] [--close 15]
               [--fps 30] [--sat 70] [--val 200] [--json out.json]
```
The closed light (or dark) region nearest `--near` (default 960,540), the label on it swallowed by a morphological
close: box and centre per frame, drift included, in 1920×1080 px. `--sat`/`--val`: the light mode's max saturation and
min value (dark mode: value < 255 − val). In GLEA, feed `--json` to `scenefx.push_into(point_of=…)` /
`shape_window(center_of=…)`. Check a frame by eye.

## `seam_compare.py` — any video: where versions differ, and a film to see it

```
seam_compare.py diff BASE.mp4 OTHER.mp4 [OTHER2.mp4 …] [--thr 3] [--fps 30] [--json out.json]
seam_compare.py video --sources A.mp4,B.mp4[,C.mp4] --labels "A","B"[,"C"] --windows windows.json --out X.mp4
                      [--slow 2] [--fps 30] [--font PATH] [--foot TEXT]
```
`diff`: frame ranges (and seconds) where each version differs from BASE on a 160×90 grey copy (mean difference >
`--thr` levels). It lists ranges only: a part that must stay frozen shows no range. `video`: the changed joins only,
slowed, as a 2×2 grid of the versions and a notes panel (windows.json: `[{"f0","f1","title","lines"}]`, film frames);
`--foot` is the notes footer. `--font` takes a TTF; without it the tool tries Inter (~/Library/Fonts), macOS Arial and
Linux DejaVu Sans, and stops with a message when none exists.

## `film_profile.py` — any video: rig films (one 3D world, no cuts; [../world-rig-films.md](../world-rig-films.md))

```
film_profile.py RENDER out.json [--plot out.png] [--marks F1,F2,…]
```
seam_check's `scan()` over the whole film: rows f, vx, vy, zoom, luma, mad, cut, method; `--plot` draws speed, |zoom|
and luma; `--marks` draws lines at your planned joins. On a rig film the joins are found here, not in seam_check's
seam list.

## `lib/`

- `vp.py` (GLEA projects) — safe edits of one project and range renders. Global flags go before the command:
  ```
  vp.py [--board B] [--project P] [--work-dir DIR] [--config C.json] [--dry-run] [--project-json P.json] COMMAND
        get [--out project.json] | overlaps [--lo-f F] [--hi-f F] | dump [--lo-f F] [--hi-f F]
        | render F0 F1 OUT.mp4 [--width W --height H] [--renderer webgl|webgpu] | still TIME_S OUT.png
  ```
  `render`: film frames F0…F1 at 30 fps, the project's size and the app's engine by default, kept off the board,
  written under the work folder. `--project-json` reads a saved GET for `get`/`overlaps`/`dump`. As a module:
  `vp.configure(…)`, `vp.get()`, `vp.patch(fn, who, note, …)`, `vp.render_frames(f0, f1, out)` (see its `--help`).
- `easing.py` + `editor_easings.json` (GLEA projects) — the editor's keyframe curves (a snapshot of `GET /api/video-editor/capabilities`
  → `easings.keyframe`, loaded on import). `easing.py fetch caps.json` saves a fresh copy (to your work folder; point
  `$SEAM_EASINGS` at it after an app update), `easing.py eval caps.json "Expo Out" 0.25`, `easing.py track caps.json
  keys.json 37.5`. `Custom` keys play their own bezier; an unknown easing name raises an error.
- `keyfit.py` — motion as the fewest eased keys: [its own section](#keyfitpy--motion-as-the-fewest-eased-keys).
- `glpath.py` (GLEA projects) — lines with corners as straight legs and one radius:
  [with keyfit below](#lines-with-corners-glpathpy).
- `scenefx.py` (GLEA projects; spec: [../scene-seams.md](../scene-seams.md#in-the-video-editor)) — scene seams: `push_into`, `shape_window`, `mark_iris`, `blur_ramp`, `hold_camera_exit(d, seq_clip_id,
  key_idx)`, safe `new_channel` / `new_clip` / `new_item`; generic mechanics, the looks come from each film. Every
  move is 2–3 eased keys a track: `fitted(item, track, frames, fn)` writes any curve of yours the same way and
  keeps it inside the curve's own range, and `uncovered(item, f0, f1)` says how far a full-frame item's edge pulls
  inside the frame while its keys play (a push carries its point on the zoom's own curve, so it stays covered).
- `timeline.py` (GLEA projects) — where items sit (freeStart, snapped channels, cross transitions); shared by seam_check and seam_fit.
- `rig.py` (GLEA projects) — a starting point for evaluating a WORLD-null rig and projecting it to the screen
  (`pinhole(H)` = (H/2)/tan 14°, 2166 at 1080 tall). Calibrate per film
  ([../world-rig-films.md](../world-rig-films.md#in-the-video-editor)).
- `kitlib.py` (GLEA projects) — API calls, the `$SEAM_…` variables, small file helpers.

## `keyfit.py` — motion as the fewest eased keys

The rules are design.md's ([A move is two keys](../../video-design.md#a-move-is-two-keys-and-an-easing),
[Computed and measured motion](../../video-design.md#computed-and-measured-motion-fit-it-then-write-it)); `curve` and `moves`
work on any curve, `check` and `thin` on GLEA projects:

```
keyfit.py curve CURVE.json --tol T [--rel] [--max-keys 10] [--no-refine] [--item-f0 F --item-frames N] --out K.json
keyfit.py moves TRACKS.json --noise N [--item-f0 F --item-frames N] --out K.json
keyfit.py check PROJECT.json [--min-keys 8] [--fps 30] [--easings E.json] [--items id,…] [--tracks t,…] [--strict] [--allow-stops id,…]
keyfit.py thin  PROJECT.json --out NEW.json [--items id,…] [--tracks t,…] [--min-keys 8] [--fps 30] [--easings E.json]
```

- **`curve`** fits an exact computed curve and prints the fitted keys with their beziers for any tool. `CURVE.json` is
  `[[film frame, value], …]`; `--item-f0` / `--item-frames` (the item's first film frame and its played length, or
  `to_glea(keys, f0, n_frames)`) also turn them into GLEA `propertyKeyframes` (`K.json → propertyKeyframes` is the track
  to write). Tolerances: `--tol 1` for px, degrees and opacity; `--tol 0.003 --rel` for scale and zoom (0.3 %). In a
  script: `keys, err = keyfit.fit(frames, values, tol, rel)`, then `keyfit.to_glea(keys, f0, n_frames)`;
  `scenefx.fitted(item, track, frames, fn)` does both on an item and returns the value its keys play. The tightest fit
  needs `scipy`; without it the same tolerance is met with more keys.
- **`moves`** fits MEASURED tracks (a tracker, hand-read seeds) as moves, each with the measured speeds at its keys;
  `curve` is for exact computed curves.
- **`check`**, on a project GET before delivery (pass `--easings lib/editor_easings.json` to `check` / `thin`: without
  it every track with a named easing is left alone): it lists every numeric track with `--min-keys` keys or more, in
  sequences too, and exits 1 when one of them can be drawn with half its keys or fewer. On every motion track,
  whatever its length, it also prints the `STOP` keys (a move that goes on eases to 0 and starts again) and `JOLT` keys
  (its speed jumps): on screen a step. `--strict` fails on those and on 8+ keys under 0.4 s apart (`MANY`; 8+ keys far
  apart are listed as `LONG` and pass); `--allow-stops ITEM,…` keeps the stops a reference really makes (name them in
  the report). Check the parents as well: a child under `keyframeParenting` (`type: "additive"`) rides every key of its
  parent, so a stepping group null steps every card in it, and a "pop" keyed on the card on top of a drift on the group
  is two gestures.
- **`thin`** refits the tracks `check` lists: in the live project with `keyfit.thin_item(item)` inside a `vp.patch`
  change function, or `keyfit.py thin P.json --out NEW.json` to write a copy to look at. It leaves alone `Hold` steps,
  tracks with an expression, split slices (`easeSlice`), colours, paths and noisy tracked data. Fix tracks where they
  are written (fit them in your builder) when you can. Deliver with exit 0, or name each track it still lists and why.

### Lines with corners: `glpath.py`

The rule is design.md's [Corners on a line](../../video-design.md#corners-on-a-line-straight-legs-and-one-radius). In a
project, `shapePath` points live in the shape's box (±0.5, x and y scaled separately), and the tangent rule of
[video-shapes.md](../../video-shapes.md#writing-the-handles) is for free curves: compute a connector's anchors and handles in
composition px, then divide x by the box width and y by its height.

```
glpath.py corner --points "x,y x,y x,y" [--radius 20] [--snap 4] [--frame 1920x1080]   # item fields of a `line`
glpath.py check PROJECT.json                                                           # HOOK / LEAN, exit 1 on one
```

`corner` takes composition px from the frame centre (y down) and returns `shapeType`, the px box, `shapePath` and
`panX`/`panY`: straight legs, legs within `--snap`° of vertical or horizontal made exact, every turn rounded with one
radius. `check` lists every shape path, line and motion path whose curve turns far more than its anchors (a HOOK: a
smooth tangent through a sharp turn curls back) or whose straight leg leans a few degrees (a LEAN). As a module:
`glpath.corner_path(points, radius)`, `glpath.paths_check(data)`. Fix those where they are written.

## Contact sheet

Any video, with ffmpeg alone.

Every 2nd frame of a 3-s window, 6 per row (45 frames at 30 fps), to read a join or hunt a carrier:

```
ffmpeg -v error -ss T0 -t 3 -i render.mp4 -vf "select='not(mod(n\,2))',scale=480:-1,tile=6x8" -frames:v 1 sheet.jpg
```

Tile k (left to right, top to bottom) is the frame at T0 + 2k/30 s. Put T0 1.5 s before the join to see A's last
1.5 s and B's first 1.5 s.
