> **GreenLight Motion Engine:** this is the GreenLight Dash Video Editor's project format, which the engine reads as is.
> Ignore the `/api/...` routes and the app UI described here: in the engine you edit `project.json` (or `apply`) and run
> `npx greenlight-motion build`; what `GET /api/video-editor/capabilities` returns there is `npx greenlight-motion schema <topic>`
> here. `frontend/src/…` paths are files of the engine's public source repository. MotionFast templates (`mediaType: "motion"`)
> stay in GreenLight Dash.

# Motion grammar: the cases behind the rules

The rules are in [video-design.md](video-design.md#motion-grammar). These are the real films that taught them: what was built, what
it measured, and what the user said. Read them when a rule seems too strict for the film in front of you.

## Keys

- **A key on every frame buys nothing** ([A move is two keys](video-design.md#a-move-is-two-keys-and-an-easing)). A push into
  a point written as 6 eased keys and the same push written as 75 per-frame keys rendered the same picture: on every
  frame checked they differed by under 0.1 of 255 levels on average.
- **One gesture, not phases** ([One gesture](video-design.md#one-gesture-per-element)). In the 2026-11-16 rebuild a card that
  "appears tilted and makes one move" was built as "it scales up and turns, then it moves down", each piece eased on
  its own. The user: "again, it's stepped".
- **A camera move is straight.** Fitted axis by axis through tracked cards, the same rebuild's camera had 9 keys per
  axis, its zoom breathed and x arrived before y. The user: "whole camera movement feels like trash. Remake it totally
  and make straight and good".
- **Keys in a chain carry the speed** ([Keys in a chain](video-design.md#keys-in-a-chain-carry-the-speed)). The card group
  drifted down in 3 segments, each eased out to zero: the card's speed on screen went 12.5 → 0.8 → 9.5 → 0.6 → 3.5 → 0
  px/f, where the reference's falls once, smoothly, 17 → 0.6 over 50 frames.
- **A segment never goes past its keys.** After a fitter change every card and the camera of that rebuild had handles
  past 0..1, and the user felt it at once: "feels like you added elastic easing", "all motion has overshoot".
- **No small back-and-forths.** A layer whose x went +3, −2, +3 px while it fell 600 px read as sliding "slightly left,
  right instead of direct smooth movements".
- **Settled things stay still, at the measurement's own limit.** On a track that later travels 2000 px, a 1 % limit
  held a title's real 24 px drift still and then kicked it into motion.
- **Never hold a stretch in the middle of a track:** the data jumped where it resumed (a 52 px step in 10 frames).
- **A hold is its own segment:** a pull-back fitted across a hold, meant to start at a cut, began shrinking 80 frames
  before it.

## Fitting

- **A fitted curve stays inside what it fits** ([Computed and measured motion](video-design.md#computed-and-measured-motion-fit-it-then-write-it)).
  A scale fitted from rest dipped 0.1 % under it for a frame: an open edge on a full-frame layer.
- **A measured track is fitted as moves.** A generated texture that waves on its own scatters a tracker even more than
  ±1–5 px; keys fitted through any scatter at the exact-curve tolerances gave drag, jiggle and stepping on screen
  though every key was "within tolerance".

## Corners

- **Never a smooth tangent through the corner points** ([Corners](video-design.md#corners-on-a-line-straight-legs-and-one-radius)).
  The 2026-11-16 connector, drawn with tangents through its points, turned 208° where its anchors turned 93°.
- **A straight leg is exact.** Two measured points 27 px apart made a 500 px leg lean 3°.

## Joins

- **The reference film** ([Joins](video-design.md#joins-one-move-across-the-cut)): a SaaS film of 37 seams over 1590 frames,
  measured frame by frame. 30 of its seams keep the direction of motion, 29 cut within ±2 f of the move's peak speed;
  21 are hard cuts and 16 continuous, and its mean shot is 41.8 f (1.39 s).
- **The card flies off in the next shot's direction.** "The card flies off left while the next scene dissolves in" was
  accepted; "a hard cut from a card to black is too sharp". Flying the card off in the next shot's direction (the next
  line re-centres ← → fly ←; the next word rises ↑ → fly ↑) removed all four pops to black and white in one film.
- **No sharp jerks.** Rejected on real films: a ±1° camera roll in 5 f with easeOutExpo on each arrival; a card
  turning 2° in 3 f; a card dropping back 5 % in 3 f.
- **Two depths.** A smooth pass changed ~2 s of a 1-minute film and the user didn't see the difference; a full smooth
  rework (~5 s) read as "a bit smoother"; a scene pass on 4 joins changed only 2.7 s and was seen at once.
