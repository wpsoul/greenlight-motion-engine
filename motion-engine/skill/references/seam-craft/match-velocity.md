> **Use this only when you can run Python on this computer; in a chat without a computer, follow the rules in [video-design.md](../video-design.md#motion-grammar) and skip this.**

# Match velocity — the maths and the easing table

The rule is design.md's [match velocity](../video-design.md#joins-one-move-across-the-cut); this page is its maths and the
solver that writes it. Units: [Seam Craft's](README.md#units): frames at 30 fps (scale counts by fps/30), px of a
1920×1080 frame, zoom in % per frame on the log scale, rotation in °/frame.

## Why

Most joins that "stutter" are not wrong in position, they are wrong in **speed**: the out shot eases to a stop, the
in shot eases from a stop, or the in shot starts at a third of the speed the eye was following. The fix is a handle,
not a new animation: the slope of an eased segment at its start and end is set by its bezier handles.

## The maths

A key segment runs from key k (time t0, value v0) to key k+1 (time t1, value v1). Its length in frames is
`T = t1 − t0`. With easing curve E (u ∈ 0…1):

```
v(u)        = v0 + (v1 − v0) · E(u)
dv/dframe   = (v1 − v0) / T · E'(u)
```

For a `cubic-bezier(x1, y1, x2, y2)` curve (the CSS form):

```
E'(0) = y1 / x1          (start slope; x1 > 0)
E'(1) = (1 − y2) / (1 − x2)   (end slope; x2 < 1)
```

Named curves are in [the easing table](#the-easing-table) below; for any other curve, take its slopes numerically from
the curve at u = 0, 0.01 and 0.99, 1.

So, keeping the segment's values and length, **multiplying `y1/x1` by r multiplies the start velocity by r**, and the
same for the end slope with `(1 − y2)/(1 − x2)`. The handle's other end keeps the curve's landing shape. Clamp:
`0 < x1 < 1`; when the needed slope would push `y1` above ~2.5 (an overshoot you didn't ask for), shorten the segment
(move key k+1 earlier) or raise the value span instead, and say so.

**Screen velocity vs key velocity.** A key's unit is not always screen px: a layer inside a scaled group, a camera pan
in % of the frame, a scale key (the velocity of a zoom is `d ln(scale) / dframe`). So solve **relative to a
measurement**: measure the screen-space velocities on both sides of the seam with `seam_check.py`
([seam-check.md](seam-check.md)), and scale the segment's slope by `r = target / measured_in`. No unit conversion is
needed as long as that key is what moves the picture at the seam (check the result with `seam_check` again).

**A static side.** When one side has no move at all, a handle can't help (0 · r = 0). Add a short move:
- *landing* on the in shot: two keys, from `base − Δ` at the seam to `base` at seam + L, eased out, with
  `Δ = v_target · L / E'(0)` (E'(0) from the table below);
- *exit* on the out shot: from `base` at seam − L to `base + Δ` at the seam, eased in, `Δ = v_target · L / E'(1)`.
Defaults: L = 12–20 f for pans, 15–30 f for zooms (15 and 20 when in doubt); for a zoom Δ is in log units:
`scale_end = scale_base · e^(±Δ)`.

## The easing table

Every curve as a `cubic-bezier` with its common name and its start and end slopes. The power, sine, expo and back
curves are formulas, not cubic beziers: their `cubic-bezier` is the closest single one (≈), and **its slopes differ from
the exact curve's**. Use the slopes of what your tool plays: the exact column when it plays the formula (GSAP's power
curves, for one), the bezier column when you type the `cubic-bezier`. Exact slopes are measured over the first and
last 1 % of the curve. The Video Editor's name for each curve, and which it plays exactly:
[video-keyframes.md](../video-keyframes.md#common-names-of-the-curves); GSAP's: hyperframes.md (GreenLight Dash only);
the CSS keywords: [video-motion-in-code.md](../video-motion-in-code.md#easing-curves).

| Curve | `cubic-bezier` | E'(0) / E'(1) of the bezier | Exact curve | At a seam |
|---|---|---|---|---|
| linear | `(0, 0, 1, 1)` | 1 / 1 | — | a constant drift |
| easeInQuart (t⁴) | ≈ `(0.895, 0.03, 0.685, 0.22)` | 0.03 / 2.48 | 0 / 3.94 | the default exit |
| easeOutQuart | ≈ `(0.165, 0.84, 0.44, 1)` | 5.09 / 0 | 3.94 / 0 | the default landing |
| easeInCubic (t³) | ≈ `(0.55, 0.055, 0.675, 0.19)` | 0.10 / 2.49 | 0 / 2.97 | a softer exit |
| easeOutCubic | ≈ `(0.215, 0.61, 0.355, 1)` | 2.84 / 0 | 2.97 / 0 | a softer landing |
| easeInExpo | ≈ `(0.95, 0.05, 0.795, 0.035)` | 0.05 / 4.71 | 0 / 6.69 | a whip's exit |
| easeOutExpo | ≈ `(0.19, 1, 0.22, 1)` | 5.26 / 0 | 6.69 / 0 | a whip's landing |
| easeInSine | ≈ `(0.47, 0, 0.745, 0.715)` | 0 / 1.12 | 0 / 1.57 | a gentle drift out |
| easeOutSine | ≈ `(0.39, 0.575, 0.565, 1)` | 1.47 / 0 | 1.57 / 0 | a gentle drift in |
| easeInBack | ≈ `(0.6, −0.28, 0.735, 0.045)` | −0.47 / 3.60 | ≈ 0 (dips back) / 4.64 | an exit with a wind-up |
| easeOutBack | ≈ `(0.175, 0.885, 0.32, 1.275)` | 5.06 / −0.40 | 4.64 / ≈ 0 (overshoots) | a landing with a small overshoot |
| power out (quint-like) | `(0.23, 1, 0.32, 1)` | 4.35 / 0 | — | a hard landing |
| Apple-style out | `(0.32, 0.72, 0, 1)` | 2.25 / 0 | — | a soft landing (panels, drawers) |
| glide (fast–slow–fast) | `(0.2111, 0.7721, 0.8541, 0.112)` | 3.66 / 6.09 | — | a stall between two fast legs (SR-10) |
| glide stop | `(0, 0.9125, 1, −0.0338)` | vertical / vertical | — | near-jumps at both ends: never on a matched leg |
| slow down | `(0, 0, 0, 1)` | vertical (x1 = 0) / 0 | — | **never** on a matched in leg: its start is a jump |
| overshoot | none (a sampled curve) | — | 17.4 / 0 | only after a smash-pan's jump frames (SR-09) |
| easeInOutCubic | ≈ `(0.645, 0.045, 0.355, 1)` | 0.07 / 0 | 0 / 0 | never across a seam: at rest at both ends |
| easeInOutSine | `(0.445, 0.05, 0.55, 0.95)` | 0.11 / 0.11 | — | never across a seam |
| easeInOutExpo | ≈ `(1, 0, 0, 1)` | 0 / 0 | 0 / 0 | never across a seam |
| easeInOutBack | ≈ `(0.68, −0.55, 0.265, 1.55)` | — | ≈ 0 / ≈ 0 | never across a seam |
| natural in-out | `(0.8, 0, 0.2, 1)` | 0 / 0 | — | never across a seam |
| punch (wind-up, hard hit, long tail) | `(0.7, 0, 0.1, 1)` | 0 / 0 | — | never across a seam |
| AE easy ease | `(0.8821, 0, 0.2446, 1)` | 0 / 0 | — | never across a seam |
| AE arrive / AE leave | `(0.3142, 0, 0.0875, 1)` / `(0.87, 0, 0.6433, 1)` | 0 / 0 | — | never across a seam, despite the names |
| impulse, swing, anticipate, bounce out, elastic, smooth overshoot | none (sampled) | — | they dip, bounce or overshoot | not for a matched seam |

Most named curves start or end at zero speed, so chaining "a linear drift, then easeInQuart" dips to a stop at the
join. For a shot whose move must keep its speed into or out of a seam (landing → drift → exit), write custom
`cubic-bezier`s whose end and start slopes agree, or sample the move (linear keys every 2 f) and thin it to the fewest
eased keys (`tools/lib/keyfit.py curve`, [tools/README.md](tools/README.md)).

**Target.** Aim: pan `|v_in| = 1.0–1.3 × |v_out|`, same direction; zoom `rate_in = 1.2–2.0 × rate_out`, same sign.
Both: the out speed must still be rising on the out side's last frame (its peak within 2 f of the cut). `seam_check`
passes a wider band (pan 0.8–1.5, zoom 1.0–2.4; [seam-check.md](seam-check.md)): aim inside the narrow one.

## Solving one seam

1. Measure the seam: `seam_check.py RENDER --seams F` gives the out and in speeds and the ratio.
2. Read the two segments that meet at the seam: their values, times and curves (the out segment ends at the cut, the
   in segment starts there).
3. Out segment: give it an accelerating end (end slope ~3, or the slope that gives the out side's measured speed).
4. In segment: set its start slope to `S × (ratio × |v_out|) / |v_in|`, keep its landing handle (x2, y2), keep its
   values and times. A static side gets the landing or exit move above.
5. Write the curves as custom `cubic-bezier`s, render the seam's range, and check it.

A layer that rides a motion path is matched on its **progress track**: the path keeps its shape, and the progress
segment at the seam gets the accelerating end or the moving start. A linear progress has no landing handle to keep:
when the layer stays in the shot after its last key, give the in segment a landing as well (end handle ≈ (0.5, 1)),
or it enters at speed and stops dead (measured: it stopped from 19 px/f; with the landing its last step was 0.5 px).
Its speed on screen is the progress speed × the path's length per % there, along the path's direction at the seam
([video-design.md](../video-design.md#curved-moves-ride-a-motion-path)).

## Check

After every change: render the seam's range (film frames F−20…F+20) and measure it with the film offset, so the
numbers line up with film frames:

```
seam_check.py out.mp4 --seams 20 --film-offset F−20
```

Confirm: same direction, ratio inside the aim band, peak within ±2 f.

## In the Video Editor

`tools/seam_fit.py` writes this page's maths into a live project. It reads the speeds `seam_check.py` measured,
rewrites one segment's bezier handle (or adds a short landing / exit move), and writes through `tools/lib/vp.py`
(GET → change on fresh data → PUT with `expected_version`, a 409 reruns it). The editor's curve names and which it
plays exactly: [video-keyframes.md](../video-keyframes.md#common-names-of-the-curves).

```
seam_fit.py inspect --item ITEM [--track T] [--at-frame F]
seam_fit.py match   --seams seams.json --seam F [--in ITEM:TRACK] [--out ITEM:TRACK]
                    [--ratio 1.2] [--out-slope 3] [--out-velocity V] [--soft-landing]
seam_fit.py land    --seam F --in ITEM:TRACK  (--velocity V | --from-seams seams.json) [--frames L] [--easing "Cubic Out"] [--ratio 1.2]
seam_fit.py exit    --seam F --out ITEM:TRACK (--velocity V | --from-seams seams.json) [--frames L] [--easing "Cubic In"] [--ratio 1.2]
every command:      [--board B] [--project P] [--work DIR] [--fps 30] [--dry-run]
```

- `ITEM` is an item id, `SEQ_ITEM/ITEM` inside sequences; `camera:TRACK` is the camera clip covering the seam
  (`SEQ_ITEM/camera:TRACK` for a sequence's own camera). `--seam F` is a film frame (the first frame of the incoming
  shot).
- `match` needs `--in` and/or `--out`: `--out` gives the last segment before the seam an accelerating end (end slope
  `--out-slope`, or the out side's mean speed `--out-velocity`); `--in` makes the first segment after it start at
  `--ratio` × the out speed, keeping values, positions and the landing handle.
- `land` / `exit` add a short move to a static side (L default 15 f pan, 20 f zoom; V in track units per frame, zoom
  tracks in log units; `--from-seams` takes V from the other side).
- A layer on a motion path is matched on `ITEM:motionPathT`: the path keeps its shape, and the progress segment at the
  seam gets the accelerating end (`--out`) or the moving start (`--in`). The tool reads the path at the seam: which
  axis it runs along there and how many px one % of progress is. It refuses an item whose path is not live.
  `seam_fit.py inspect --item ITEM --track motionPathT --at-frame F` reads its real screen position and speed on
  every frame.
- `--soft-landing` (with `--in`, any track) also ends the in segment at rest: its end handle becomes (0.5, 1). A
  segment that was `Linear` has a constant-speed end, so a layer that stays on screen after its last key stops dead
  there; the plan names that stop when it finds one. Leave it off for a layer that leaves the frame at speed.
- It refuses `camZoom` / `camX` / `camY` under Smart Zoom and `camX` / `camY` / `camDolly` under a Camera Rig, and
  warns for a path or an aimed rig ([the camera at a join](../video-transitions.md#the-camera-at-a-join)).
- `--board` / `--project` default to `$SEAM_BOARD` / `$SEAM_PROJECT`; logs go to `<work>/seam_fit_log.jsonl`.

Then render the range and check it:

```
tools/lib/vp.py --board B --project P render F−20 F+20 out.mp4
tools/seam_check.py out.mp4 --seams 20 --film-offset F−20
```

**Fix order by verdict:** `stop_start` or ratio → `seam_fit.py match`; `still_side` → `seam_fit.py land` / `exit` (or
an anchor, or a dissolve while the old card leaves); reversed direction → change the incoming move; `too_sharp` →
`land` on the still side, or carry the card off; `holds` → retime or speed up the screen.

## In HyperFrames and in code

The same maths as tween lengths and slopes, with a tested pair: hyperframes.md (GreenLight Dash only)
and [video-motion-in-code.md](../video-motion-in-code.md#match-velocity-in-code).
