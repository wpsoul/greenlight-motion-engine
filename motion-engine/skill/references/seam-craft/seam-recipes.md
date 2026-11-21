> **Use this only when you can run Python on this computer; in a chat without a computer, follow the rules in [video-design.md](../video-design.md#motion-grammar) and skip this.**

# Seam recipes — SR-01…SR-12

How to build each of the twelve seam types ([video-design.md](../video-design.md#the-twelve-join-types): what each is and when to
choose it), in any tool, with the Video Editor's names and fields beside the neutral ones. Units:
[Seam Craft's](README.md#units): frames at 30 fps (scale counts by fps/30), px of a 1920×1080 frame (scale by H/1080).
Curve names are those of [the easing table](match-velocity.md#the-easing-table), each with its `cubic-bezier` and
slopes, and the editor's name in brackets ([video-keyframes.md](../video-keyframes.md#common-names-of-the-curves)). Every recipe
ends with its check.

**In the Video Editor** the fields are: [video-keyframes.md](../video-keyframes.md) (`propertyKeyframes`, `Custom` + `bezier`),
[video-camera.md](../video-camera.md) (camera clip: `camX` % of frame width, positive pans right so content slides LEFT; `camY`;
`camZoom` × about the centre; `camDolly` px), [masks.md](../video-effects.md#greenlight-dash--layer-masks) (`layerMask` with `msk:<mid>:<chan>` tracks),
[effects-layer.md](../video-effects.md#greenlight-dash--layer-effects-reference) (`motionBlur` with `mblurShutter`, `glass`),
[effects-warps.md](../video-effects.md#greenlight-dash--warp-layer-effects) (`cornerPin`), [video-shapes.md](../video-shapes.md) (`trackMatte`); the term map and the
traps at a join are in [video-transitions.md](../video-transitions.md#joins-in-the-editor-the-fields-of-the-motion-grammar). One
editor limit touches most recipes: a camera in Smart Zoom, Rig or path mode ignores its pose keys
([the camera at a join](../video-transitions.md#the-camera-at-a-join)). `motionBlur` and `cornerPin` work on a layer inside a
sequence as at the top level; in a grid cell Motion Blur is skipped.

## Contents

- [The reference film](#the-reference-film)
- [SR-01 · Momentum cut](#sr-01--momentum-cut)
- [SR-02 · Anchor match cut](#sr-02--anchor-match-cut)
- [SR-03 · Shape window / iris](#sr-03--shape-window--iris)
- [SR-04 · Morph in a blur valley](#sr-04--morph-in-a-blur-valley)
- [SR-05 · Shared element](#sr-05--shared-element)
- [SR-06 · Screen ↔ device](#sr-06--screen--device)
- [SR-07 · Shape / colour rhyme](#sr-07--shape--colour-rhyme)
- [SR-08 · Type choreography](#sr-08--type-choreography)
- [SR-09 · Crisp smash-pan](#sr-09--crisp-smash-pan)
- [SR-10 · Push-wipe / light change](#sr-10--push-wipe--light-change)
- [SR-11 · Depth swap](#sr-11--depth-swap)
- [SR-12 · Mark lockup](#sr-12--mark-lockup)
- [Fixing an existing film's seams](#fixing-an-existing-films-seams)

---

## The reference film

The types were measured on the reference film (`examples/reference_film_seams.json`, ids T01…T37 = its seams). Only
the craft is described; the reference's objects, words and look are never copied.

| SR | Type | Reference seams |
|---|---|---|
| SR-01 | Momentum cut | T02, T08, T09, T10, T13, T25, T30 |
| SR-02 | Anchor match cut | T03, T04, T12, T22, T27 |
| SR-03 | Shape window / iris | T01 (opens), T26 (closes) |
| SR-04 | Morph in a blur valley | T05, T35, T36 |
| SR-05 | Shared element | T15, T16, T31, T32 |
| SR-06 | Screen ↔ device | T07, T18, T29 |
| SR-07 | Shape / colour rhyme | T14 |
| SR-08 | Type choreography | T19, T20, T21, T27, T34 |
| SR-09 | Crisp smash-pan | T17, T23, T24 |
| SR-10 | Push-wipe / light change | T11, T33 |
| SR-11 | Depth swap | T28 |
| SR-12 | Mark lockup | T06, T37 |

Frequency in the reference: 21 hard cuts, 16 continuous seams; 30/37 keep the direction of motion; the mean shot is
41.8 f (1.39 s). A big content change the user should see gets a scene seam ([scene-seams.md](scene-seams.md)): hunt
this film's frames for a carrier (a shape → window, a screen → push-through, a surface → fly-into, the mark → iris, or
a kind nobody used yet), check the seam ledger, and build it from the building blocks there.

## SR-01 · Momentum cut

**Use when** both shots can move and nothing is shared. The default seam.
**Build**
- Give A an exit: the last 12–25 f (0.4–0.8 s) of A's move eased **in** (easeInQuart / easeInCubic: `Cubic In` /
  `Ease In`), still accelerating on its last frame. Give B a landing: the first 8–35 f eased **out** (easeOutQuart /
  easeOutCubic / easeOutExpo: `Cubic Out` / `Ease Out` / `Expo Out`), same direction.
- Put the move where it is cheapest: one camera move spanning the cut (a key, ease-in → a key at the cut → ease-out)
  when both shots sit under one camera; otherwise a position / scale move on each shot. In the editor: a camera clip
  spanning the cut when both shots sit on the same channel under one camera, the camera in `free` mode; otherwise item
  `translateX` / `translateY` / `scale` on each.
- Zoom-outs: scale the shots (item `scale`), not the camera (a `camZoom` zoom-out shows the layers' edges), or overscan
  both shots ×1.2–1.3.
- Optional scale step on the cut, ×0.5…×1.4 in the zoom's direction (B starts that much wider/closer).
- Never a curve that starts or ends at rest across the seam (the in-out family, natural, punch, AE easy ease…: `Smooth`,
  `Natural`, `AE Smooth`, `Punch`) and never slow down (`Slow Down`) ([the easing table](match-velocity.md#the-easing-table)).
- Solve the joint from the measured speeds ([match-velocity.md](match-velocity.md#solving-one-seam)): B's start slope
  = ratio × A's end speed. A static side gets a short landing or exit move. In the editor `seam_fit.py match` writes the
  joint, `seam_fit.py land` / `exit` the static side ([match-velocity.md](match-velocity.md#in-the-video-editor)).
- Vertical variant: content rises on both sides (−35…−42 px/f at the cut). Device chain: the same UI on bigger and
  bigger devices, each a zoom-out, cut on the zoom-out.

**Defaults** aim pan ratio 1.0–1.3, zoom ratio 1.2–2.0, peak ±2 f. Motion blur on the moving layers at a 180° shutter:
per-layer blur when the move is on the layers, whole-frame blur when the move is on the camera (a per-layer blur often
reads only the layer's own motion). In the editor: a `motionBlur` entry (`mblurShutter: 180`) on each moving layer,
which reads the layer's own keys, motion paths and parenting, not the camera; a move on the camera clip takes the
project's `motionBlurEnabled` instead ([video-projects.md](../video-projects.md#motion-blur-render-only), render-only).
**Check** `dir_cos ≥ 0.7` or zoom same sign; ratio in band; `stop_start` false.

## SR-02 · Anchor match cut

**Use when** one element exists on both sides (a word, a caret, a button, a panel, a product).
**Build**
- Lay A out so the anchor ends where B needs it (shift A's line or its translate so the key word lands centred after
  A's push).
- Fade everything but the anchor on A over the last 3–4 f (opacity 1 → 0, easeInCubic: `Ease In`).
- On B, the anchor is a NEW layer at the same centre and size (Δ ≤ 20–30 px, ×0.95–1.3). It may restyle (white → a
  gradient fill) with a rack focus: blur 24 → 0 px over 8 f + scale 0.64 → 1, easeOutCubic (`Ease Out`).
- Keep the camera move running through the cut (SR-01 underneath): the anchor carries the content change, the move
  carries the time.
- Push-in on a point that is not the frame centre: scale the layer about that point (its transform origin,
  `keyframeTransformOrigin`, at the anchor); a camera zoom pivots on the frame centre.
- An anchor that travels (a toolbar rising): the same group (a sequence) on both sides, a vertical move (`translateY`)
  easeInCubic before / easeOutCubic after (`Ease In` / `Ease Out`), at equal speed (−13 px/f both sides in the
  reference), even across a ×1.3 scale step.

**Check** `seam_check --anchor F:x,y,w,h` → `anchor_dx ≤ 30 px`, scale 0.95–1.3.

## SR-03 · Shape window / iris

**Use when** a section opens or closes; the film has a distinctive mark or shape.
**Open (window):** the next shot B is masked by the shape at the frame centre.
- B gets a vector mask with the shape's outline (in the editor `layerEffects: [layerMask]` with the shape's path, add),
  or a matte: the shape as its own layer, B showing only inside it (`trackMatte {sourceId: <shape item>, mode:
  "alpha"}`; a matte also works on a nested group).
- Mask size 6 % → 300 % of B's box over ~33 f, **easeInQuart** (`Cubic In`: it flies at the lens). In the editor the
  size is `msk:m1:w` / `h`, or the matte item's `scale`.
- Feather grows with speed: 4 → 185 → 340 px, easeInCubic (`Ease In`, on `msk:m1:feather`). Few tools tie feather to
  speed, the editor included: key it.
- B inside moves slower than the mask: B's scale 0.5 → 1.0 easeInQuart (`Cubic In`) over the same span, then
  1.0 → 1.065 easeOutExpo (`Expo Out`): the parallax reads as flying through.

**A mark with an open centre** (petals meeting in a point, a ring): flying through the centre never fully opens the
frame; cross-fade to the unmasked plate over the last 2 f.
**Close (iris):** A goes soft first (blur 0 → 8 px over 6 f), then the shape shrinks to a point in ~17 f (glide
`cubic-bezier(0.2111, 0.7721, 0.8541, 0.112)`: `Smooth Glide`, on the size), turning ~10°/f (`rotate`, linear),
feather = the blur.
**Gaps** a built-in iris is usually a circle only (the editor's Circular Wipe); where a mask cannot cut a nested group
(a `layerMask` cannot cut a sequence container), matte the group from a shape layer (`trackMatte` from a shape item),
or flatten it to one video first.
**Check** the shape stays centred (±10 px); the window always outgrows the plate inside it.

## SR-04 · Morph in a blur valley

**Use when** a word becomes the mark, the mark becomes an object, and back.
**Build**
- Out: the word dissolves letter by letter, left → right: a per-letter text animation to blur 40 px + opacity 0,
  easeInCubic, ~6 f per letter (in the editor a `textAnimators` out-range over chars, `Ease In`).
- The bridge: an ellipse/blob in the last letter's colour with 30 px blur moves from that letter to the centre
  (easeInCubic then easeOutCubic: `Ease In` then `Ease Out`).
- In: the mark arrives blur 30 → 0 px, scale 0.2 → 1.05 → 1 (**easeOutBack**: `Back Out`), rotation −120° → 0
  (easeOutCubic: `Ease Out`).
- The valley: 4–8 frames where everything is heavily blurred; no frame shows both shapes readable.
- Object ↔ mark (a bloom, a product): a hard swap at the SAME centre (±1 px) during a fast spin that keeps its
  direction (the spin accelerates easeInQuart into the swap, the mark continues easeOutExpo: `Cubic In`, `Expo Out`);
  a dark halo (a blurred black circle) can grow 200 → 1100 px in 3 f (easeInExpo: `Expo In`) to change the background
  at the same time.

**Gaps** with no metaball effect (blur + alpha threshold) use blur + scale + opacity as above, or a generated / 3D
shot for an organic morph. The Video Editor has one: the `gooey` effect on a sequence of the shapes
([effects-overlay.md](../video-effects.md#gooey)).
**Check** the blur valley: sharpness (Laplacian variance) < 15 % of its neighbours for 4–8 f; centre ±10 px.

## SR-05 · Shared element

**Use when** B is one of many things in A (a card in a grid, a screen in a row) or the reverse: tile ↔ full frame ↔ grid.
**Build**
- Expand: the tile lifts (a 2–4 f scale ×1.03 + a shadow-free glass edge), then grows on a log curve to the full
  frame: punch `cubic-bezier(0.7, 0, 0.1, 1)` (`Punch`), or easeInCubic to ~70 % then easeOutExpo (`Ease In`, then
  `Expo Out`), 12–25 f; the grid behind pushes back (scale ×0.95) and dims.
- Collapse: the full frame shrinks about the centre into the centre tile of a NEW, bigger grid (natural
  `cubic-bezier(0.8, 0, 0.2, 1)`: `Natural`, ~10–18 f), and the camera keeps pulling back into that grid (SR-01
  continues).
- Rounded corners grow from 0 at full frame to the tile's radius. Where a video layer's corner radius can't be keyed,
  animate a rounded-rectangle matte. In the editor key the item's own `borderRadius` (keyframable on video and image
  items too, in px); while the tile also scales, `borderRadiusScaleLock: true` makes the keyed value its on-screen size
  ([video-shapes.md](../video-shapes.md#card-framing-on-every-visual-layer)).
- Pop forward from a row: the camera pushes in (easeInQuart: `Cubic In`, peak ×1.2/f) while framing brackets / side
  cards fly outward (easeInExpo: `Expo In`) and the backdrop softens one step (a hold key on its blur: `Hold`).

**Check** the tile's box is continuous (no jump > 30 px between frames); the zoom ratio across the seam in band.

## SR-06 · Screen ↔ device

**Use when** the frame A is (or can be) the screen of a device in B, or the camera pushes through a screen.
**Build**
- Pull-out: use ONE background/page asset both as A's full-frame plate and inside B's screen (corner-pinned into the
  screen: `cornerPin` on the screen layer). Cut while A is already zooming out (easeInQuart: `Cubic In`, ≥ 8 %/f); B
  continues the pull-back from scale ≈ 2.2 → 1 with easeOutExpo (`Expo Out`) or a custom landing fitted from log keys
  (`tools/lib/keyfit.py curve`).
- Same page flat → on a device: make sure the page shows the same state on both sides (step any carousel one frame
  before the cut).
- Push-through: a camera zoom (`camZoom`) easeInCubic (`Ease In`) → one linear peak frame → easeOutExpo (`Expo Out`);
  swap the screen for the full-frame layer on the peak frame, placed at the scale the camera reached (step ×1.3–1.4).

**Check** the screen's picture matches across the seam (anchor check on the page); zoom same sign.

## SR-07 · Shape / colour rhyme

**Use when** A ends on shapes of one colour that can become B's shapes (highlights → layout blocks, a pill → a button).
**Build** rectangles of A's colour at A's positions (±20 px) start B; they fill with B's content one batch per frame
(hold keys, `Hold`, 3–4 frames), usually with a small pull-back running through (SR-01).
**Check** the shapes' boxes match ±20 px on the cut.

## SR-08 · Type choreography

- **Shot → word gap:** A (a nested group: a sequence) shrinks to a 16:9 card (easeInCubic to ~50 %, then easeOutSine:
  `Ease In`, then `Sine Out`, ~18 f) while two words slide in from the frame edges (easeOutCubic / easeOutExpo:
  `Ease Out` / `Expo Out`) and frame it as a word of the line.
- **Letters regroup:** the line breaks into letters; letters not needed drop out in random order, shared letters slide
  to their new slots (~5 f each, easeInOutCubic: `Smooth`), new letters arrive. Without a text morph (the editor has
  none yet): one text layer per letter.
- **UI born in a word gap:** the gap between two words opens (easeInBack → easeOutSine: `Back In` → `Sine Out`), a
  glass pill appears in it and multiplies into a toolbar (copies with a stagger), pushing the words off-frame; the
  toolbar then rises and becomes the anchor of an SR-02 cut.
- **Phrase push:** the old phrase blurs and drifts out; the next, ×1.6–2.3 bigger, enters blurred from the same side
  and racks into focus; the drift direction continues (SR-01 on type).
- **Kinetic line:** words arrive ~12 f apart from the right, blurred and coloured, turning sharp in ~7 f; the line
  re-centres as it grows (the earlier words glide left).

Use your tool's per-word / per-letter text animation presets for every entrance (in the editor, the Text Animator
presets: [video-text-presets.md](../video-text-presets.md), [video-text-kinetic.md](../video-text-kinetic.md)).

## SR-09 · Crisp smash-pan

**Use when** moving between two parts of one large layout (a chat → the code, a list → a detail).
**Build** a camera move easeInExpo (`Expo In`) → 1–2 jump frames (65–86 % of the distance) → easeOutExpo / overshoot
(`Expo Out` / `Overshoot`), 20–25 f in all; **no motion blur** on the UI. If your tool's motion blur is global, turn it
off for this move and blur only the layers that need it: in the editor `data.motionBlurEnabled: false`
([video-projects.md](../video-projects.md#motion-blur-render-only)) and `motionBlur` only on the layers that need it. Start it on a
click: the button changes state in one frame (+ a click sound), the move starts on the next frame.
**Check** the landing is readable within 6 f (sharpness back to ≥ 80 % of the hold).

## SR-10 · Push-wipe / light change

- **Push-wipe with a stall:** the new layer's hard edge travels across the frame fast → stalls ~20 f as a split screen →
  fast again (glide `cubic-bezier(0.2111, 0.7721, 0.8541, 0.112)`: `Smooth Glide`), and the picture under the edge
  drifts the same way at 25–65 % of the edge speed: a rectangle mask whose edge (x / width: `msk:m1:x` / `w`) is keyed,
  plus a horizontal move (`translateX`), both on the glide curve. A built-in wipe transition on the glide curve (`Wipe`
  + `Smooth Glide`) is the simpler fallback (no drift).
- **Light band:** the outgoing panel grows from its top edge past the frame (easeInCubic: `Ease In`) while the
  background dissolves into a colour glow over ~9 f (easeOutCubic: `Ease Out`); the next text lands on the same line.

**Check** the edge never stops for longer than the planned stall; no frame of pure flash (luma clipping) unless asked.

## SR-11 · Depth swap

**Build** A's subject recedes (scale ×0.72, easeInQuart: `Cubic In`, a little blur and dim) toward the centre while the
background stays identical; B's subject rises from the bottom edge (a vertical move, `translateY`, easeOutExpo:
`Expo Out`) and settles frontal (its 3D tilt on the X axis, `rotateX`, → 0, easeOutCubic: `Ease Out`).
**Check** the background is identical across the seam (diff < 4 levels); B's rise starts within 2 f of A's recede peak.

## SR-12 · Mark lockup

**Build** the mark shrinks and slides (or rolls) aside: roll = horizontal move + rotation with rotate° = dx / r · 57.3
(r = the mark's radius; key both on the same curve, natural `cubic-bezier(0.8, 0, 0.2, 1)`: `Natural`; the editor has
no rolling constraint, so `translateX` and `rotate` ride the same keys); the wordmark appears from behind it on the
roll's fastest frame (a wipe mask on the text, or a text reveal: a Text Animator reveal). Rhyme it with the opening if
the mark opened the film (SR-03).
**Check** no slipping: rotation and position stay in ratio on every frame (±5 %).

---

## Fixing an existing film's seams

### The order

1. Render (or take the latest render) and run `seam_check.py` on it; when your tool can export its layer boundaries,
   pass them so soft seams are found too ([seam-check.md](seam-check.md)). In the editor: `seam_check.py RENDER
   --project-json P.json` (a project GET), so the item boundaries are checked as soft seams.
2. For each FAIL/WARN: `stop_start` / ratio → re-solve the handles ([match-velocity.md](match-velocity.md#solving-one-seam));
   `still_side` → a landing / exit move on the still side (or SR-02, or a dissolve while the old card leaves);
   reversed direction → change the incoming move (or the outgoing exit) so they agree; `too_sharp` → give the static
   side a drift or carry the card off while the next fades in; `holds` → remove the frozen frames (retime, speed up
   the screen). In the editor `seam_fit.py` does each by its verdict: `match`, `land` / `exit`
   ([match-velocity.md](match-velocity.md#in-the-video-editor)).
3. Re-render only the ranges you changed (in the editor `vp.py render F0 F1`), run `seam_check` again with
   `--film-offset`, and report each seam before → after.

### Read the verdicts by seam type

- **`seam_check`'s verdict is for moving seams: SR-01 / 02 / 06 / 09.** SR-03, 04, 05, 08, 11, 12 have their own
  checks above (blur valley, centre ±px, identical background, roll ratio…): run those and report them. The tool's
  FAIL on them (e.g. SR-03's slower plate inside the window) is expected, not a bug.
- **Plate checks use the whole frame** (95th percentile of luma), never a corner patch: a shaded corner misled a
  match and made the jump worse.

### Before you plan

- **Measure the captures first.** A screen recording or an HTML scene with its own follow camera moves by itself and
  dominates the picture's motion. Run `seam_check` (or `--seams` on the capture alone) on each capture's in and out
  points; plan the seam on what the picture really does (twice the planned direction turned out to be the reverse).
- **UI at ≥ 1× near a seam.** A capture slowed below 1× repeats frames, which are holds at the seam. Speed screens up,
  never down.
- **A held plate takes a share of the move.** "Plate held still, cards move" makes `seam_check` follow the textured
  plate and call the seam still; give the plate 0.2–0.3 of every camera/card move (it reads as depth too).
- **The hero rule beats a punch cut.** If a hero (the prompt box, the card) is on both sides of a planned punch-in/out,
  make it one continuous push instead of a cut.
- **Is the incoming layer opaque?** Upper layers (titles, glow layers) are often transparent: "dissolve the next shot
  in over the old card" then does nothing, so fade the old card to the canvas instead. Render one frame of the
  incoming layer alone before planning an overlap.

### Timing traps

- **Look at the cut frame itself.** A layer still drawn on the cut frame shows a fake reversed move: end the out
  layer just before the cut, and run a video that freezes near its end past the cut, hidden. In the editor an item
  whose end equals the cut time is still drawn on the cut frame, and a video item freezes ~4 frames before its end:
  run it past the cut and hide it with a `Hold` key on `opacity`.
- **Cut where the hero arrives, not where the layer starts.** A scene whose card rises in 0.15–0.35 s after its start
  shows a flat backdrop at the seam, and fixing the camera slope changes nothing. Move the cut later onto the hero's
  peak arrival: hold the out shot's last frame under its exit, trim the in shot's head by the same frames.
- **Hold a frame as a still image,** not as a video slowed to a tiny speed (a slowed video can render more frames than
  the span says: in the editor 0.11× rendered 26 frames where the span said 8).
- **Put cuts on frame boundaries:** the editor's preview draws instants between export frames
  ([the editor's traps at a join](../video-transitions.md#editor-traps-at-a-join)).

### Reworks and ports to a newer version

- **Full rework = one idempotent build script on a fresh copy.** Rebuild the new version from the source copy with
  every seam edit in one script and one write per iteration (in the editor one versioned PUT per iteration): no stacked
  keys, no drift between tries. In-place fixes (`seam_fit`'s writes) suit a light pass. Tune with range renders
  (`vp.py render`, `seam_check --seams … --film-offset …`), ~16 s each.
- **Port edits by role, not id.** Layer ids get reused for other content between versions. Carry an edit to a newer
  version by the layer's name and its boundary role ("X's end under Y's start"), shift the frames, and drop the edit
  when that join no longer exists. Write layer names into recipe files and logs.
