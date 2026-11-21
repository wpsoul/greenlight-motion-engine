> **Use this only when you can run Python on this computer; in a chat without a computer, follow the rules in [video-design.md](../video-design.md#motion-grammar) and skip this.**

# World-rig films: transitions in one 3D world with no cuts

Some films have no shots. One 3D world hangs on a world parent (a null) that travels between stops. Cards arrive and
exit on their own parents, and cursors ride parent chains that switch parents between cards. The rest of Seam Craft
assumes shots joined by cuts, so on a rig film several of its tools mislead. This page covers what changes for the
transitions. Units: [Seam Craft's](README.md#units).

## Finding the joins

- **Don't trust `seam_check`'s seam list here.** With a project's layer boundaries it lists every one of them: cursor
  segments, tags, small layers. One rig film got ~140 rows for about 11 real joins.
- **Use the whole-film motion profile.** Run `tools/film_profile.py RENDER out.json --plot out.png` (`--marks F1,F2,…`
  draws your planned joins on it). It plots seam_check's own per-frame scan: speed, zoom and luma. A join is a
  travel between two rests, with a content hand-over in it.
- **Define the join as the travel.**
  - *Pass:* the travel's peak sits at the hand-over of the two cards. Match velocity's rule is already met, even
    though the travel eases in and out. Don't rewrite every travel because "never an in-out curve across a seam".
  - *Stop-start:* there is a gap between the card's exit and the next card's arrival: the exit peaks, several frames
    sit at 0 px/f, then the arrival peaks.
  - *Reversal:* a layer swings against the travel just before the join.
- **Expect the smooth pass to be short.** On a rig film most joins already pass, so the scene pass is what the user
  will see.

## Moving things on screen in a world

Every visible card is the sum of its parents, so a screen path has to be turned into keys on those parents.

**Projection.** A pinhole camera at perspective distance P (px) draws a point at depth Z with scale `s = P / (P − Z)`
(Z towards the camera), at `x = W/2 + X·s`, `y = H/2 + Y·s` (Y positive down). P = (H/2) / tan(fov/2) for the
camera's vertical field of view; your tool's value is in its adapter. Calibrate it once against `carrier_box` on two
frames; it should hold within a few %.

**What the scene pass needs:**
- Project a layer: its screen box at frame f, through all its parents.
- Screen path to parent keys: the keys that put a card at a wanted screen box while its parents keep moving.
- Hold on screen: keys that cancel the world's travel for one layer. Use it for anything that must wait while the
  world moves, such as an anchor or a device under a landing window.
- Resample: new keys over a window that join back into the untouched keys, so the film after the window is identical.
  End the window on a key the track already has, and the keys after it stay as they are.
- Extend a layer: rescale its keys in time and lengthen it.

**All of these are a few eased keys, not a key on every frame**
([video-design.md](../video-design.md#computed-and-measured-motion-fit-it-then-write-it)). Compute the wanted values
on every frame of the window (project the layer, solve what its parent needs), then fit that curve to the fewest
eased keys and write those:
- A hold while the world travels in the picture's plane is the world's own keys with the opposite sign: the same
  times, the same curves. With a depth change the counter-move is a product of curves: fit it, and expect a key at
  each of the world's keys, where its speed changes.
- A track that can't be fitted inside 1 px carries two moves or a wrong parent, not a need for more keys.

**The per-seam velocity solver and the full-frame scene-seam blocks don't apply here:** the blocks write full-frame
layers, and the solver changes one segment's handle, while a rig film needs path changes on chains of several parents.

## Depth traps

- **Depth decides what is in front, not the stacking order.** A world layer stacked higher still hides behind a
  nearer card. A dissolve "B over A" is decided by Z.
- **Keep a layer clear of a turned card's surface.** A layer passing in front of a turned card must stay ≥ 20 px in
  front of the card's *surface* at that point: card Z + x·sin(rotY), not the card's centre Z. At rotY −5° a wide card's
  near edge can be 60+ px in front of its centre, and layers just in front of the centre vanish there.
- **Parent rotation.** Children turn with their parent; world-parented layers don't. A layer you re-parent to the
  world for a hold loses the card's tilt.
- **Device mockups.** The screen is not the image box. Measure the screen area: it can be ~85 % of the image and sit
  off centre when the device is turned.
- **Groups stacked behind a hero.** A row of cards or devices is often built stacked behind the front one and fanned
  out later. When you change the hero's arrival:
  - hold the whole group;
  - fade the hidden members in only after the hero is opaque, or they show as ghosts through it.

## More transition moves in a world

- **Re-path a cursor across its parent segments.**
  - Cursors switch parents between cards. One smooth screen path is planned on screen (an arc: a motion path's
    shape), then solved against each segment's own parent chain and written as fitted eased keys per segment, with a
    key on both sides of every parent switch at the same screen position.
  - A "never go back" rule fails for layers that dock on the far side of an arriving card. Dock them late instead,
    when the slot has slowed.
- **Cut a camera move out between two depths** (e.g. a zoom-out the user doesn't want):
  - keep the outgoing group's depth (cancel the world's Z on its parents), so it leaves sideways and never shrinks;
  - fade the screen-space shapes that were keyed to the old camera;
  - give the incoming card its original on-screen arrival, shifted in time.
  - Then check that every frame has a scene on it: a carrier flying alone over the empty world reads as a gap.
- **A carried tile between scenes (SR-05).**
  - Crop the carrier from the film's own media, not the render: the render bakes in overlay cursors.
  - Leave a hole patch where it was.
  - Crossfade mid-flight into a crop of the target's own pixels, then dissolve into the target.
  - The target must already be arriving while the tile flies.

## Numbers that worked (cards travelling across a moving world)

| Seam | Length | Curve and timing |
|---|---|---|
| Frame collapses into a selection box (SR-05) | 28 f | smoothstep on the log scale; fade the card over the last 10 f |
| Window shrinks into a device screen (SR-06 pull-out) | 36 f | device fades in over 9 f; hidden siblings fade in 6 f later. Only when the window's aspect, corners and tilt match the screen ([scene-seams.md](scene-seams.md) "Shapes must match") |
| Anchors held while a card is pulled out flat (SR-02) | 22 f | easeInCubic; easeInQuart gave a bigger luma step on the last strip |
| Carried tile between scenes (SR-05) | ~45 f | lift 6 f, fly 33 f, dock 5 f |
| Smooth dock of a stack onto an arriving card | — | each layer waits, then a cubic Hermite into its slot at the card's velocity; pick the latest start at which x never goes back |
| Card leaving at the lens while the next scene comes in | 9 f | dissolve while it flies at the lens; the incoming layer starts nearer |

## Checks

These are in addition to [scene-seams.md](scene-seams.md) "Checks" (lock the base render first, only the planned
windows changed, read every join).
- **Recipe checks are per film.** Near-black frames, the largest one-frame luma step per join, anchor drift over the
  window, and music identity. A rig film's checks script needs its own join windows.
- **Noise floor.** Two renders of the same data can differ in small spots inside embedded screen videos. Measure that
  once before you call a stray range a change.
- **Music when SFX moved.** A transition can move its SFX, so the whole-mix hash can't match. Check instead:
  - the music layer's settings are unchanged;
  - the PCM hash matches outside the moved SFX windows.
- **The film's own carries count.** The ledger lists scene seams only. A new seam can rhyme with a move the film
  already has. Note it for the user.
- **Range renders are cheap:** plan 6–10 tries.

## In the Video Editor

- **The rig:** a WORLD null item travels between stops; cards sit on their own nulls (`keyframeParenting`), and
  cursors ride null chains that switch parents between cards. Every visible card is the sum of its parents.
- **Projection:** `s = P / (P − Z)` with `P = (H/2) / tan 14°` (2166 at 1080 tall), `x = W/2 + X·s`, `y = H/2 + Y·s`,
  `translateY` positive down; static `panX` / `panY` are % of the frame (× W/100, × H/100), `panZ` px.
  `tools/lib/rig.py` evaluates a WORLD-null rig and projects it (`rig.pinhole(H)` gives P); calibrate it once per film
  against `carrier_box.py` on two frames.
- **Screen path → null keys:** keys that put a card at a wanted screen box while its parents keep moving; "hold on
  screen" keys cancel the world's travel for one layer; resampled keys join back into the untouched keys. Compute
  the wanted values on every frame with `rig.py`, then write them as the fewest eased keys: `keyfit.fit(frames,
  values, tol)` and `keyfit.to_glea(keys, f0, n_frames)` (1 px for translate tracks). A hold against a world that
  only travels in X / Y is the world's own keys with the opposite sign. Children of a `keyframeParenting` parent turn
  with it; a layer re-parented to the world for a hold loses the card's tilt.
- **`scenefx` and `seam_fit` don't apply:** `scenefx` writes full-frame items, and `seam_fit` rewrites one track's
  handle; a rig film needs path changes on chains of parents. `hold_camera_exit` works on a sequence whose camera
  follows a path (`camPathT`).
- **Joins:** find them with `film_profile.py` (seam_check's list floods with item boundaries on a rig film).
- **Small images draw at their pixel size × zoom,** and the depth order of turned layers decides what is in front:
  [the editor's traps at a join](../video-transitions.md#editor-traps-at-a-join). Render times:
  [seam-check.md](seam-check.md#in-the-video-editor).
