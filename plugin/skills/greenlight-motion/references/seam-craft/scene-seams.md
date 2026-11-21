> **Use this only when you can run Python on this computer; in a chat without a computer, follow the rules in [video-design.md](../video-design.md#motion-grammar) and skip this.**

# Scene seams — change the scenes at the join

A **smooth pass** (match velocity, carries, dissolves: the rest of Seam Craft) fixes stutters and pops. A **scene
pass** gives a join an idea: the end of one shot turns into the start of the next through something the picture
already shows (design.md's [Two depths](../video-design.md#joins-one-move-across-the-cut)). This file is the method and the
building blocks. It is **not** a list of looks: what carries each join is found in each film's own frames, every time
anew. Units: [Seam Craft's](README.md#units).

## Smooth pass or scene pass

A smooth pass changed ~2 s of a 1-minute film and the user didn't see the difference; a full smooth rework (~5 s)
read as "a bit smoother"; a scene pass on 4 joins changed only 2.7 s and was seen at once. What made it visible is
that each join shows **a new idea**, not a slightly different move. So:

1. Do the smooth pass first. It is the floor: no stop-start, no pops, direction kept.
2. Then run a scene pass on the **3–5 joins that carry the biggest content change**: a section change, words ↔
   picture, one world to another. The small steps inside a section stay plain momentum cuts.

## Uniqueness: every film gets its own seams

The rules are design.md's ([Every film gets its own joins, the seam ledger](../video-design.md#joins-one-move-across-the-cut)):
the carrier comes from THIS film at THIS join, never from another film's set; no two scene seams of one film share
both SR type and carrier kind; the brand mark at most once per section (a bookend: its power is rarity); scene seams
alternate with plain cuts. The kinds below are mechanics, not looks to repeat. In practice:

1. **Read the seam ledger before planning.** It lives in the user's notes for the project or board, in a section
   "Scene seams used"; add the section if there is none (in the app, the board memory:
   [In the Video Editor](#in-the-video-editor)). Each new scene seam differs from every entry in at least two of the
   carrier (what object), the SR type, the move (push / pull / slide / turn / fall / fold…) and the shape.
2. **After delivery, append the film's scene seams to the ledger**, one line each:
   `film · join (time) · carrier · SR · move · the user's verdict`.
3. **Invent when nothing fits.** Look for a carrier kind the ledger doesn't have yet (the table below is open, not a
   menu). Failing that, leave the join a good smooth seam. Never fall back to a repeat.

## The carrier hunt (per join)

1. Make a contact sheet every 2 f of A's last 1.5 s and B's first 1.5 s (A = the outgoing shot, B = the incoming
   one): the command is in [tools/README.md](tools/README.md#contact-sheet).
2. List everything that could carry the eye from A to B.
3. Choose the carrier that says the most about the content change. Example: "the bridge connects your apps" → the
   cable; "your agent writes" → the caret; "post it" → the send button.

Kinds of carriers seen so far, each with its seam and the building blocks below. A new kind you find goes into the
ledger with its film; this folder is read-only.

| In the picture | The seam | Build |
|---|---|---|
| A closed shape: button, pill, chip, frame, card, badge, speech bubble, a letter's counter | it becomes a window onto B; the camera flies into it (SR-03 window) | push into a point + shape window |
| A screen inside A (monitor, preview, phone, thumbnail) whose picture is close to B's look | push through the screen; B is its content at full frame (SR-06) | hold the camera's exit + push into a point + blur ramp + a dissolve |
| A flat surface whose colour is near B's background (card, wall, sky, a big letter) | fly into it; its colour becomes B's background (SR-11 / SR-07) | push into a point + blur ramp, B fades in on the colour |
| The brand mark, or a shape from it | closes a section as an iris on the last hero (SR-03 close) | mark iris |
| A word in A that is (or can be) in B | the word stays, the world changes around it (SR-02 / SR-08) | [seam-recipes.md](seam-recipes.md) SR-02 / SR-08 |
| An object in both shots (product, cursor, card, avatar) | carried across, place and size kept (SR-05) | [seam-recipes.md](seam-recipes.md) SR-05 |
| A line or vector (cable, swipe, light beam, scroll) | it runs on into B (SR-01 / SR-10) | [match-velocity.md](match-velocity.md) + [seam-recipes.md](seam-recipes.md) |
| A selection box, lasso or focus ring drawn round B's subject | A's frame collapses into it (SR-05) | [seam-recipes.md](seam-recipes.md) SR-05; on a rig film see [world-rig-films.md](world-rig-films.md) |
| A device whose screen can hold A (laptop lid, phone, tablet) | A shrinks into the screen and the device fades in round it (SR-06 pull-out). **Only if A's outline matches the screen**, see "Shapes must match" | [world-rig-films.md](world-rig-films.md) numbers |
| A shape at the end of A matching one at the start of B (circle ↔ dial, bar ↔ timeline) | match the shapes, cut on the match (SR-07) | [seam-recipes.md](seam-recipes.md) SR-07 |

## The building blocks

Generic mechanics with tested numbers, on a 1920×1080 frame at 30 fps. Measure the carrier first with
`tools/carrier_box.py RENDER --frames F0-F1 [--mode light|dark] [--near x,y]`: it gives the box and centre per frame,
including the drift the shot gives the carrier by itself.

**Push into a point** (a camera push into a point of a full-frame layer).
- **Scale.** The end scale S1 must make the target cover the frame: S1 ≥ max(1920 / w, 1080 / h) × 1.05. A capsule
  needs the height rule (its round ends).
- **Length and curve.** Run it over 15–22 f with an ease-in on the log scale (`S(u) = S1^(u^p)`, p 2–3): it starts at
  rest and peaks at the cut.
- **Where the point goes.** It travels to the centre on the zoom's own curve (by `u^p`, the same p), or to a nearby
  point to keep the shot's drift direction. The point then never runs ahead of the zoom. A travel that leads it (by
  u² under a u³ zoom) pulls the layer's edge inside the frame at the start: 6 px for 7 frames on a ×4.5 push into a
  point 400 px off centre.
  If the content drifts by itself, measure the carrier's centre, smooth it, and let the push compensate the drift.
- **Keys.** The scale grows about the point (the layer's transform origin sits on it): 2 keys. The point's travel
  is 2 keys on each axis it moves along. A push is 6 keys, never one on every frame
  ([video-design.md](../video-design.md#a-move-is-two-keys-and-an-easing)).
  The fitted scale never dips under its rest value, not by 0.1 %: on a full-frame layer that is an open edge.
- **The layer's edge.** With that travel a full-frame layer covers the frame through the whole push while the
  point's way to its end place is under `ln(S1)` × its distance to the frame's edge on that side (×4.5: 1.5 ×, ×12:
  2.5 ×). A point nearer to the edge than that uncovers the frame: aim it at a nearer place, raise S1, or keep a
  layer or the background under it.

**Shape window** (the shape becomes a window).
- **Matte size.** Make the matte 97–98 % of the measured shape: a thin rim of the original stays, and that rim is what
  reads as "the shape opens". It follows the shape's scale and centre with the push's own keys (the same times, the
  same curves), so the rim also holds between frames.
- **Inside.** A dark plate, plus B's backdrop **held still**, both matted by the window. The window moves, the world
  inside doesn't. A backdrop layer scaled below ×1 shows its box edges.
- **Timing.** The window opens over 4 f while the push starts.
- **Hand-off.** B starts at the cut on the same backdrop with no fade.

**Push through a screen.**
- **Freeze the camera first (hold the camera's exit).** A world whose own camera leaves at the end of the shot carries
  the screen off the frame: hold the camera on the framing it has before its exit move, then push.
- **Push.** ×4–4.5 over ~22 f.
- **Blur ramp.** 1.5 → 14 px over the last 12 f. Without it, the screen's UI text overlaps B's first words.
- **Dissolve.** Fade the world out over B's first 7 f.

**Fly into a surface.**
- **Push.** ×4–4.5 over ~22 f about the surface centre.
- **Blur ramp.** Up to ~24 px.
- **Hand-off.** B fades in over ~9 f on the matching colour. Pick a surface whose colour is within ~40 L of B's
  background (a pale surface into a white plate worked).

**Mark iris** (the mark closes the shot).
- **What it does.** A frame-size black layer is matted to show only outside the mark (an inverted alpha matte from the
  mark image).
- **Start.** It fades in over 8 f while the mark is ~×2.3 of a 1024-px image. At that size the shape reads at once;
  larger starts show only black wedges.
- **Close.** The mark shrinks to 0 with an ease-in (`(1 − u^2.2)`) over ~24 f, turning ~75°: 2 keys on the scale
  and 2 on the rotation.
- **Centre and hand-off.** Centre it on the last hero. B's words arrive after it closes.

**Shapes must match** when A turns into a shape in B (a window landing in a device screen, a frame collapsing into a
box, a tile docking in a slot, a shape opening as a window): the aspect ratio, the corner radius, each edge on the same
pixels, the turn (rotation and tilt), as design.md's [Joins](../video-design.md#joins-one-move-across-the-cut) say. A
mismatch is seen at once, and users reject it; when A's outline can't match, keep A's frame on screen and bring B
*under* it (the device slides in under the frame until the frame is its screen, and the shot continues), or don't
morph. Check it on the 2-f sheet at the hand-off frame: the outlines overlap with no visible step. **The hand-off rule
for all of them** is design.md's too: B starts on what the window, screen or surface showed, with no fade from black
and no flash.

## Checks

- **Lock the base first.** Copy the base render into the work folder at the start, or re-render the copied version
  yourself on the same engine. A shared render can be overwritten by another session mid-task, and the diff then
  reports changes you didn't make.
- **Only the planned windows changed.** Run `tools/seam_compare.py diff OLD.mp4 NEW.mp4`: the changes sit only in the
  planned windows, and frozen parts (an approved opening, the music) show no range.
- **No new black frames.** A frame with mean luma < 4 must have been there before. No one-frame luma step > 60 at
  the join unless it was planned.
- **Read every join** on a contact sheet every 2 f ([tools/README.md](tools/README.md#contact-sheet)) and check:
  - the carrier is recognisable on the seam's first frame;
  - no text of A sits under B's text for more than 2 f;
  - no layer's box edge shows.
- **No sharp jerks anywhere:** scan every layer's keys as design.md's [No sharp jerks](../video-design.md#joins-one-move-across-the-cut)
  says (hard rule 5).
- **Few keys:** every track the scene pass wrote has a handful of eased keys (hard rule 9;
  [Check the motion](../video-design.md#check-the-motion-before-delivery)).
- **Report recipe checks, not `seam_check` ratios.** Its ratio verdicts don't apply here: a ×4 push reads as a huge
  zoom rate.
- **An anchor seam must change the world round the anchor.** Small anchors (cursor tags ~100 px) held in place change
  about 1 frame. Move the partner visibly (pull the card out from under them), or pick a bigger anchor.
- **Give the user a comparison to watch.** If only ~2 s changed, `tools/seam_compare.py video` makes a slowed 2×2 film
  of the changed joins (old · new · notes); otherwise say plainly that the change is subtle.

## Compositing traps

- **Mattes.** A matte source must exist over the same frames as the layers it mattes. With no source under the
  playhead the matte is empty: an alpha matte hides the layer, an inverted one shows it whole.
- **3D world layers.** They are ordered by depth, not by stacking order. See [world-rig-films.md](world-rig-films.md)
  "Depth traps".
- **Transparent groups.** Glow and title layers are often transparent: a window or dissolve "into" them shows
  whatever is below. Put a plate under them inside the window.
- **A blur that rises from 0** can draw a black frame in some tools: start the ramp from a small step (1.5 px).

## In the Video Editor

`tools/lib/scenefx.py` builds the blocks above on a project's `data` (edit it inside a `vp.patch` change function). It
assumes 30 fps and 1920×1080.

| Block | `scenefx` call |
|---|---|
| Push into a point | `S, T, Q = push_into(item, f0, f1, S1, point, Q1=C, powr=3.0, point_of=None, pivot=True)` on a full-frame item: `scale` about the point (it sets `keyframeTransformOrigin`) and `translateX` / `translateY` carrying the point to `Q1` on the zoom's own curve (`travel=` sets another exponent), 2 eased keys a track. The item covers the frame through the push and its scale never dips under ×1. A rotated item keeps its origin and gets translate keys that compensate. It warns when a point too near the frame's edge pulls the item's edge inside the frame. Returns what the keys play |
| Shape window | `shape_window(d, after_ch, tag, f0, f1, size, scale_of, center_of, inside=(), radius=None, open_f=4, plate="#000000")` — a hidden shape matte that follows the shape (pass the push's `S` and `Q`: it gets the same few keys), a dark plate and the `inside` layers matted by it |
| Mark iris | `mark_iris(d, after_ch, tag, f0, f1, mark_url, center, S0=2.3, rot=-75.0, powr=2.2, fade_f=8, feather=(1.5, 6.0), mark_px=1024)` — a black frame layer with an `alphaInverted` matte on the mark image; 2 keys on its `scale`, 2 on its `rotate` |
| Blur ramp | `blur_ramp(item, f_from, f_to, peak, step=1.5, easing="Cubic In")` — 3 keys: holds 0, steps to 1.5 (the black-frame trap), eases to the peak |
| Any curve of your own | `at = fitted(item, track, frames, fn)` — `fn(film frame)` as the fewest eased keys on the track, never outside the curve's own range; `at(f)` is the value they play |
| Hold the camera's exit | `hold_camera_exit(d, seq_clip_id, key_idx)` — a sequence's path camera (`camPathT`) keeps the framing of key `key_idx` to the end; read the keys first with `seam_fit.py inspect --item SEQ_ITEM/camera --at-frame F` |
| Safe new layers | `new_channel` (unsnapped), `new_clip` (shape clips padded by 1 s), `new_item` |

Measure the carrier with `carrier_box.py` and pass its `--json` to `push_into(point_of=…)` / `shape_window(center_of=…)`.
`push_into` smooths a measured drift before it compensates it (the measurement steps by ±1 px).

The seam ledger and anything you learn on a film go into the board's memory
(board-memory.md (GreenLight Dash only)), section "Scene seams used" (add the section if the memory has none), one
line per scene seam. The editor's traps that cost a render here (new layers that sit at 0 s, short synthetic shapes
not drawn, the blur-from-0 black frame): [video-transitions.md](../video-transitions.md#editor-traps-at-a-join).
