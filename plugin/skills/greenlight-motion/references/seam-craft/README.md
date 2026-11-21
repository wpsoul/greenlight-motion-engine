> **GreenLight Motion Engine:** Seam Craft as GreenLight Dash's agents have it, for the films the engine makes,
> and only where Python 3 with OpenCV runs on this computer (in a chat, the rules in [video-design.md](../video-design.md#motion-grammar)
> alone). `seam_check.py`, `carrier_box.py`, `seam_compare.py`, `film_profile.py` and `keyfit.py curve` / `moves` read a render
> (`npx greenlight-motion render`) or a curve; `keyfit.py check` / `thin` and `glpath.py check` read the engine's `project.json`.
> `seam_fit.py`, `vp.py`, `scenefx.py` and `kitlib.py` edit and render a project through the GreenLight Dash board API:
> GreenLight Dash only; here you write the keys their recipes give into `project.json` (`apply`). In this package the folder is
> `skill/references/seam-craft/`: copy `tools/` into your work folder and run the copy.

> **Use this only when you can run Python on this computer; in a chat without a computer, follow the rules in [video-design.md](../video-design.md#motion-grammar) and skip this.**

# Seam Craft — joins built by recipe and checked by numbers

The rules of every move and every join are the motion grammar in [video-design.md](../video-design.md#motion-grammar): a move is
two keys and an easing, one gesture per element, match velocity at the cut, the twelve join types, the scene pass.
Seam Craft is the part of it that needs a computer: the recipes with their numbers, the tools that measure a render
(OpenCV) and edit a project, and the order of work that checks every join by numbers. Read it when a film should feel
crafted (a launch film, a product promo, a brand piece), when you edit or review its joins, or when a note says "too
sharp", "it stutters", "keep the direction", "make the transitions seamless / creative", "it jitters".

Its numbers were measured frame by frame on a reference product film (37 seams, 1590 frames:
`examples/reference_film_seams.json`). Seam Craft carries **no visual style**: colours, fonts, worlds and subjects come
from the film's own brief, and every film gets its own seams.

**This folder is read-only.** Write nothing into it: the seam ledger, new carrier kinds and your worked examples go into
the user's notes for the project or board (in the app, the board memory), or onto the user's board. To change a tool,
copy `tools/` into your work folder and run the copy.

## Units

Every number uses one convention, so it carries from tool to tool:

- **Time:** frames at 30 fps, with seconds where it matters. At another frame rate scale frame counts by fps/30 (the
  seconds stay), and per-frame speeds by 30/fps.
- **Position:** px of a 1920×1080 frame (scale by H/1080 for another height, by W/1920 across), or % of the frame.
  Speeds in px per frame.
- **Zoom:** % per frame on the log scale (`d ln(scale) / dframe` × 100); a scale step as a factor (×1.3).
- **Rotation:** degrees, speeds in ° per frame.
- **Easing:** a curve's common name with its `cubic-bezier(x1, y1, x2, y2)` and its start and end slopes E'(0) and
  E'(1) ([the easing table](match-velocity.md#the-easing-table)). The power, sine, expo and back curves are formulas:
  their `cubic-bezier` is the closest one, with different slopes.
- **Neutral terms:** shot, layer, group (a nested composition), parent (a null), key, segment (the span between two
  keys), easing curve, hold (step) key, transform origin, motion path (a bezier trajectory with one progress track),
  camera (zoom, pan, dolly, roll, tilt), mask, matte, motion blur. In the Video Editor they are the fields in
  [video-transitions.md](../video-transitions.md#joins-in-the-editor-the-fields-of-the-motion-grammar); in HyperFrames,
  hyperframes.md (GreenLight Dash only); in code,
  [video-motion-in-code.md](../video-motion-in-code.md#terms).

## Read when

| You are… | Read |
|---|---|
| planning a film's joins: which type where | design.md's [twelve join types](../video-design.md#the-twelve-join-types); the reference film's seams per type: [seam-recipes.md](seam-recipes.md#the-reference-film) |
| building a seam: layers, keys, curves, masks, mattes, motion blur | [seam-recipes.md](seam-recipes.md) |
| fixing an existing film's seams (the order, and the traps found on real films) | [seam-recipes.md](seam-recipes.md#fixing-an-existing-films-seams) |
| fixing joins that stutter, stop and start, or slow down at the cut: the maths, the easing table, the solver | [match-velocity.md](match-velocity.md) |
| checking a render's seams by numbers | [seam-check.md](seam-check.md) |
| giving the 3–5 biggest content changes an idea of their own: the carrier hunt, the building blocks | [scene-seams.md](scene-seams.md) |
| working on a film with no cuts: one 3D world on a rig | [world-rig-films.md](world-rig-films.md) |
| writing any move: design.md's [motion grammar](../video-design.md#a-move-is-two-keys-and-an-easing); fitting and checking keys by script | [tools/README.md](tools/README.md#keyfitpy--motion-as-the-fewest-eased-keys) |
| running the tools: setup, every command and flag | [tools/README.md](tools/README.md) |

## The one rule, by numbers

The rule is design.md's [match velocity](../video-design.md#joins-one-move-across-the-cut): the outgoing shot accelerates into
the cut, the incoming one starts already moving the same way and brakes. On the reference film 30 of 37 seams keep the
direction and 29 cut within ±2 f of the peak speed. Build to the aim; `seam_check` passes a wider band:

| What | Aim | `seam_check` passes |
|---|---|---|
| Out leg (into the seam) | 12–25 f, easeInQuart / easeInCubic, its speed still rising on the last frame | `stop_start` false |
| In leg (out of the seam) | 8–35 f, easeOutQuart / easeOutCubic / easeOutExpo; never a curve that starts at rest or slow down | `stop_start` false |
| Direction | the same | pan: cosine ≥ 0.7; zoom: the same sign |
| Speed ratio in / out | pan ×1.0–1.3, zoom ×1.2–2.0 | pan 0.8–1.5, zoom 1.0–2.4 |
| Peak speed vs the cut | within ±2 f | ±2 f (WARN ±3–4) |
| Scale step on a cut | ×0.5 … ×1.4, in the direction of the zoom | — |
| Anchor (one element kept) | centre Δ ≤ 20–30 px, size ×0.95–1.3; the rest fades out 3–4 f before the cut | `anchor_dx` ≤ 30 px, ×0.95–1.3 |
| Morph | a 4–8 f blur valley | the recipe's own check |
| Fast pan inside one UI | 1–2 jump frames, **no motion blur** | the recipe's own check |
| Holds | none: every shot keeps a slow drift (log-zoom or pan) | no identical frames within ±8 f |

**Two depths:** the smooth pass is the floor and on its own goes unnoticed; the scene pass is what the user sees
([scene-seams.md](scene-seams.md)). **No cuts?** A film that is one 3D world travelling between stops breaks the shot
assumptions: read [world-rig-films.md](world-rig-films.md) first.

## Work in three passes

1. **Plan the seams** before building (or before fixing a film): design.md's plan line per seam,
   `seam · SR type · carrier · A end (pos, scale, speed) · B start · length · curves`. A seam with neither a carrier
   nor a move is a plan error.
2. **Build** each seam with its recipe ([seam-recipes.md](seam-recipes.md)). For SR-01 / SR-02 / SR-06 solve the keys
   at the join from the measured speeds ([match-velocity.md](match-velocity.md#solving-one-seam)) instead of guessing
   handles. Every move you write is a few eased keys, and a curved one rides a motion path.
3. **Check** the render with `tools/seam_check.py`: direction, speed ratio, peak vs cut, anchor Δ, holds, "too sharp"
   cuts. Fix the failures by their numbers and re-render only that range. Look at a contact sheet of every join
   ([tools/README.md](tools/README.md#contact-sheet)). Put the seam table in the review report.

## Hard rules

The rules are design.md's ([Joins](../video-design.md#joins-one-move-across-the-cut)); here by the numbers other texts cite:

1. Direction first. 2. No stop-start. 3. No hard cut onto a still or onto black. 4. A hero never jumps. 5. No sharp
jerks: scan every layer's keys, the camera's roll and tilt included, for a step shorter than ~5 f that the plan doesn't
name. 6. One trick per seam. 8. Keep every unrelated part of the project. 9. A move is a few eased keys: count the keys
on every track you wrote (`tools/lib/keyfit.py check`).

7. **Numbers, not impressions.** Every seam you claim is fixed has its `seam_check` numbers (or its recipe check)
   before and after.

## Tools

Python 3 with `opencv-python` and `numpy`, and `ffmpeg` on PATH; setup and every command:
[tools/README.md](tools/README.md). These read any rendered video:

- `seam_check.py` — finds the seams of a render and gives each a verdict with its numbers ([seam-check.md](seam-check.md)).
- `carrier_box.py` — measures a carrier (a closed light or dark shape) on screen, frame by frame.
- `seam_compare.py` — `diff`: where versions differ; `video`: a slowed 2×2 film of the changed joins for the user.
- `film_profile.py` — the whole-film motion profile of a rig film ([world-rig-films.md](world-rig-films.md)).
- `lib/keyfit.py curve` — a dense curve (a solved pan, a log zoom, a counter-move) as the fewest eased keys.

The tools that edit a Video Editor project (`seam_fit.py`, `lib/scenefx.py`, `lib/vp.py`, `lib/rig.py`,
`keyfit.py check` / `thin`, `lib/glpath.py`) are in [tools/README.md](tools/README.md), and each page's "In the Video
Editor" section says where they fit.
