# Motion design and motion grammar: video that looks made, not generated

What makes a video read as designed rather than generated. The rules hold however the video is built — a project
through the app's API, `project.json` with the engine's CLI, or a scene script — so read them before the first version
and check every version against them.
The second half, [Motion grammar](#motion-grammar), is how every move is written and how moves meet across a cut.

> Before you build, read the field notes: [video-motion-notes.md](video-motion-notes.md), what real films taught (wrong ways and the
> right one, with values), and in the app your user's own: `GET /api/agent/engine-notes/motion`
> (engine notes (GreenLight Dash only)).

## The defaults: never and prefer

GreenLight Dash's defaults for every video: the app's agents, the engine's CLI and the chat connector all read this
list. A user's own request wins over a default ("add a text shadow", "make it bounce"). The sections after it say how to
do each one.

### Never

- **Text shadows, unless the user asks for one.** No `textShadowX` / `textShadowY` / `textShadowBlur` /
  `textShadowSpread` on a text layer, no `shadow` property in a Text Animator, no `longShadow` effect on text, no CSS
  `text-shadow` in an HTML clip or page. A shadow under type reads as a stock default and softens the letter edges; get
  legibility from contrast instead ([Hierarchy](#hierarchy)). A shadow already in the user's project stays.
- **Strong shadows on a white or light ground.** There a dark, dense shadow reads as dirt, not depth. A shadow on a light
  ground stays barely visible: blur ≥ 40 px at 1080, a small offset, tinted with the ground's own hue (never grey or
  black), about 8 % opacity or less. None on thin lines, text, small pills or badges, and never stacked on a card and
  every element inside it. Separate a light card from a light ground with its fill, a 1 px lighter edge or a frosted
  blur.
- **Neon on a white or light ground.**
- **Micro-motion or wobble on the camera:** no small jittery moves, no left-right wobble, no back-and-forth shake.
- **Overshoot or elastic on the camera's path.** The camera arrives and settles; it never passes its target and comes
  back. (Elements may overshoot: see Prefer.)
- **Very fast moves in a transition.** A layer that rushes across the frame in a few frames reads as a jerk, not a
  move. Every move and every transition stays smooth: give the layer time to travel, ease it in and out, and slow down
  anything that jumps from one frame to the next.
- **A whole line of text animated at once.** Animate words or letters ([Text animation](#text-animation)).
- **Text that leaves before it is read:** more than about 8 words on screen at once, words held under 1 s, or a line's
  animation under 0.8–1 s outside the exceptions in [Text animation pace](#text-animation-pace).
- **Punchy text presets** (Swing Pop, Whip, Letter Vortex…) on a longer line or a caption under speech: there they read
  cheap.
- **A preset with a colour band on a coloured card:** the band's colour can clash with the card.
- **One kind of transition everywhere** (it looks like a template) **or a new kind at every cut** (it looks random).
- **Depth-of-field blur on words being read.**
- **Text outside the middle 80 % of the frame** (in a project: |panX| or |panY| above 40): players and feeds crop the
  edges.
- **The `shockwave` Overlay Effect unless the user asks for a shockwave:** it reads as a stock template move
  ([video-effects.md](video-effects.md#shockwave-only-on-request)).

### Prefer

- **One idea per scene:** 3–6 scenes of 2–3 s for a short video. A scene that says two things says neither.
- **One headline per scene,** supporting text much smaller; hierarchy from size and weight, not colour alone. **One
  accent colour** and strong contrast.
- **9:16:** bigger text, stacked vertically, everything in the middle 80 %.
- **One focal move at a time.** If everything moves, nothing reads: supporting elements move less and later. Stagger
  related elements by 0.06–0.12 s. Shapes and pictures enter in 0.4–0.8 s; exits are faster than entrances.
- **Easing by intent:**
  - entrances: in-out eases such as `Natural`, `Smooth` or `AE Smooth`, or a fast start with a soft landing
    (`AE In (arrive)`, `Expo Out`, `Power`); UI panels and drawers: `Apple Out`;
  - the camera and big moves: `AE Smooth`;
  - scene changes on the beat, a logo hit, a screen swipe: `Punch` (slow wind-up, hard hit, long tail);
  - a layer that passes through (in, glide, out): `Smooth Glide` with the `glide` expression (the Glide keyframe presets
    build it, [video-keyframes.md](video-keyframes.md));
  - **playful arrivals of elements** (a button, an icon, a card, a pop-in): `Back Out` or `Overshoot`, or a real spring
    with the `spring` expression (Snappy for buttons, icons and pop-ins, Gentle for mascots and big cards). Never on the
    camera's path;
  - exits: `Ease In` or `AE Out (leave)`; the Kinetic recipes' `Anticipate` exits (wind back, then snap away) are the
    exception and stay as tuned;
  - `Linear` only for constant motion: tickers, rotation, progress along a path.
- **Text:** one family per video. Pick the text animation for this film from the whole catalogue, to fit its style
  ([Text animation](#text-animation)); punchy presets go on short titles, hooks and calls to action (up to about 5
  words, or 2–4 short stacked lines). Every text animation takes at least 0.8–1 s over the whole line
  ([Text animation pace](#text-animation-pace)).
- **Transitions and camera:** two or three kinds of transition across a video. Camera moves are slow and small unless
  they are the point; fast motion looks best at 60 fps with motion blur. A real 3D camera earns its place on one or two
  moments, not every scene: a zoom onto the one thing a scene is about (a number, the button a screen recording clicks;
  1.3–2×, then back out), or a slow orbit or push that shows depth.
- **Depth from layers at different distances:** a soft shape or picture far behind, the words at the front. Depth of
  field reads only then; keep the words sharp. Keep an orbit in front of flat layers (within about ±70°): text turned
  further goes edge-on, then mirrored.
- **Sound:** chosen for this film from the sources available, each cue where the picture's motion is
  ([Sound](#sound)).
- **Look at every version** on a contact sheet before the user sees it ([What to check](#what-to-check-in-every-version)).

## Hierarchy

When text has to read over footage or a busy picture, get the contrast from the design: a calmer or darker part of the
frame, a caption bar (`textBgEnabled`), or a shape behind the text — never a shadow under the type
([Never](#never)).

## Text animation

There is no house text animation. Choose it for each film from the whole catalogue, to fit the film's style, its
reference and what each line has to do, so two films never share their text animation by habit. A preset is a
starting point: tune its timing, easing and units, mix it with others, or build your own with the editor's animators
([video-text.md](video-text.md)).

- The catalogue: [video-text-presets.md](video-text-presets.md#pick-a-category) (typing reveals, text on shapes, highlights, loops,
  decoders, voice captions, classic reveals) and [video-text-kinetic.md](video-text-kinetic.md#when-to-use-them) (energetic
  in-and-out recipes that tilt or overshoot).
- Presets without a colour band, for a coloured card: Classic Rise (Mask), Classic Fade Up.

## Text animation pace

By default, text that animates in, animates out or gets a one-time pass (a sweep, a highlight, a typed line) takes
**at least 0.8–1 s**, counted from the moment its first unit starts to the moment its last unit settles. Faster than
that, the words flash past before anyone can read them. In a Video Editor project the rule holds however the motion is
built:

- **Advanced Animations on Time** (`textAnimators[].range.drive: "time"`): the span is
  `(units − 1) × stagger + duration`. For example, 4 words with `stagger` 0.06 and `duration` 0.8 take 0.98 s. For
  moves (rise, slide, scale, rotate, blur), reach the span with `duration`, because a long `stagger` makes a long line
  crawl. A typewriter (`duration` 0) gets its pace from `stagger`.
- **Keyframes** (`txa:` range tracks such as Start or Offset, or a text layer's own position, scale and opacity
  tracks): the first and last key of one move sit at least 0.8 s apart. Key positions are % of the layer, so a move
  from `p1` to `p2` lasts `(p2 − p1) / 100 × layer seconds`. On a layer with a speed curve, a `txa:` key's position is
  a % of the clip's source length (`trimEnd − trimStart`) instead, so time the move on that clock
  ([video-text.md](video-text.md)).
- **Layer entrances and exits** on a text layer: `transitionInDuration` / `transitionOutDuration` of 0.8 or more
  (the most they take is 3 s).
- **Recipes** from [video-text-kinetic.md](video-text-kinetic.md) and [video-text-presets.md](video-text-presets.md) keep their tuned timing.
  On very short text (one or two words), where the span works out under 0.8 s, raise `duration` until it reaches 0.8 s.

Go faster only when the edit really needs it: the user asks for snappy or fast text, a word hits on a beat or a fast
cut, a glitch or scramble flicks, the layer is too short to fit a 0.8 s move, or the animator uses `drive: "voice"`
(the speech sets the pace there).

## Sound

There are no house sounds. Choose them for each film from what is available, in this order:

1. **The user's Sound Library** (`GET /api/libraries/sound`,
   media.md (GreenLight Dash only)). If it has sounds, take them from there.
2. **If it has none, other connected sources:** a connector or tool in this session that has sound effects (a stock
   sound library, a sound-effect search).
3. **If nothing is connected, generate them** with the app's audio models (`GET /api/ai/models`, audio output;
   ai-generation.md (GreenLight Dash only)).

- Which sound suits each moment is a design choice for this film (sound.md (GreenLight Dash only)).
- Put each cue where the picture's motion is, read from the project's own data: its event timeline gives every move's
  fastest frame and its landing, each sound's facts give its loudest moment and class, and one call places the cues as
  the project's own audio clips, levelled, with a mix check (sound.md (GreenLight Dash only)).
- A sound from outside the libraries goes into the board folder first; use its board url as an `audio` clip's `url`.

## What to check in every version

Look at real frames across the video (a contact sheet) before the user sees it — the JSON doesn't show these:
blank or empty frames, overlapping or cut-off text, text too small or gone too fast, nothing moving or everything
moving at once, weak hierarchy, clashing colours, a dark halo around light cards, a camera that wobbles or overshoots, a layer that
moves too fast to follow.
Fix them and look again; two rounds are usually enough.
Then check the moves and the joins: [Check the motion before delivery](#check-the-motion-before-delivery).

## Motion grammar

How every move is written and how moves meet across a cut: the rules for motion that reads as crafted, whatever
builds the video (the editor's keys, a scene script, HyperFrames, code). Earlier called MotionGram: a request to "use
MotionGram" means this section. The defaults above say which moves to make; this says how to write them. Numbers are
for 30 fps and a 1920×1080 frame: at another rate scale frame counts by fps/30 (the seconds stay) and per-frame speeds
by 30/fps, and scale px by H/1080. A zoom's speed is % per frame on the log scale.

> **With a computer that runs Python,** the joins are also built by recipe and measured on the render:
> [Seam Craft](seam-craft/README.md). In a chat without a computer, follow this section and skip Seam Craft. The cases
> behind these rules, with their numbers: [video-motion-grammar-examples.md](video-motion-grammar-examples.md).

### A move is two keys and an easing

The keys say where a move starts and ends; the curve says how. A key on every frame draws the same picture and says
nothing: nobody can retime it, between frames it runs straight chords (a 60 fps preview and motion blur sample there),
and it hides what the move is. Write the move, not its samples.

| The move | Write it as |
|---|---|
| One eased move: a slide, a push, a fade, a turn, a zoom | 2 keys and one curve |
| A move that changes speed on purpose (lands, drifts, leaves) or holds in the middle | 3–4 keys, each segment with its own curve |
| An overshoot, a bounce, a settle | 2 keys and a curve or expression that overshoots (`Back Out`, `spring`), not more keys |
| A change of direction | a key at each turn: 3–5 |
| An arc, an S, a loop, an orbit, a swing round an object | a motion path ([Curved moves](#curved-moves-ride-a-motion-path)) |
| Growing or turning about a point that is not the layer's centre | the transform origin on that point, never position keys that compensate |
| Following another layer | a parent, never keys copied from it |
| Steps on purpose: a clock, a stop-motion cadence | hold keys, one per step |
| An element that enters, lands or leaves | one gesture ([below](#one-gesture-per-element)) |

A track with 8 keys or more under ~0.4 s apart, with none of these reasons, is not finished: those are keys on a
measurement's noise. A long camera through several real moves (a whip, a rest, a tilt) may have 8 keys far apart,
each one of its moves.

### One gesture per element

An element's move is one gesture, however many properties it touches: every property that changes starts on the same
frame and settles in its own ease (the scale may land first). Built as "it scales up and turns, then it moves down",
each part eased on its own, it reads as three steps.

- **What holds is a static value.** Read each property on its own: an angle that stays at −8° is `rotate: −8` for the
  whole shot, never −14 → −8. What does not change has no keys.
- **The parents count.** The eye sees the layer's keys plus every parent's: a pop on a card inside a group that drifts
  on its own timing is two gestures, and a chain of eased keys on the group steps every child. Judge the motion on
  screen, not one track at a time.
- **Every property starts together.** Position starting 4 frames before scale is a second gesture. Offsets (the
  overlap of animation, the stagger of [Prefer](#prefer)) are for separate parts, such as a card and its shadow or the
  words of a title, never for the transform tracks of one layer.
- **A template is not a measurement.** A generic entrance (pop, spin-in, fade-up) puts a habit where a measured move
  was: when the move was measured, the keys come from that track.
- **A camera move is straight.** A pan, a whip, a tilt: x, y and zoom share one ease (the progress on the move's main
  axis), so the frame travels one line with one rise and fall of speed, and moves chain at their keys with the speed
  carried through. A slow push-in or pull-back across several moves goes on an outer parent (a zoom about the frame's
  centre), never into the moves' keys.

### Keys in a chain carry the speed

An inner key of a move that goes on the same way is passed at speed: the ease into the key ends at the speed the next
segment starts with, as at a cut ([Joins](#joins-one-move-across-the-cut)). Two shapes break it, and both read as
steps:

- **Stop:** the segment eases to zero at the key and the next one starts from zero: move, stop, move.
- **Jolt:** the speed halves or doubles at the key, as when an ease-out into the key meets an ease that starts fast,
  or a linear segment follows an eased one.

Drop the inner key (one segment, one ease), or match the speeds at it: for a segment's `cubic-bezier(x1, y1, x2, y2)`,
the speed leaving it is `(1 − y2) / (1 − x2) × Δvalue / Δtime` and the speed entering the next is
`y1 / x1 × Δvalue / Δtime`. Most named curves start or end at rest, so a linear drift followed by an ease-in dips to a
stop where they meet: for landing → drift → exit, write custom curves whose slopes agree.

- **A segment never goes past its keys.** Its curve stays between its two values (bezier y handles within 0..1) and its
  handles stay in order (y1 ≤ y2), or it rises, stalls and rises again. A real overshoot (a pop past its size that
  settles) is its own key at the peak; handles past 0..1 play as an elastic ease, and the camera passes its mark and
  comes back.
- **No small back-and-forths.** A layer whose minor axis goes +3, −2, +3 px while it falls 600 px slides left and
  right instead of moving straight: join that stretch into one move from the key before to the key after. The main
  motion's turns are real and stay, small ones too (a rise of 18 px before a fall, a pop to 104 % that settles).
- **Settled things stay still.** A segment that moves less than about 1 % of the move, or a pixel, is a hold, not a
  creep: micro-movements read as jitter.
- **A hold is its own segment,** both its ends keys. A move fitted across a hold eases over it and starts early.
- **A stop the design makes** (it lands, rests, goes on) is kept and named. A turn (the value comes back) and a hold
  (two equal keys) are not stops.
- **Scale eases on its value,** as the editor plays it, not on its logarithm: speeds matched in log space jump on screen.

### Curved moves ride a motion path

Two position tracks draw a straight line when their curves agree and a hook when they don't. A move that should travel
an arc rides a path:

- **The shape is the anchors and their handles.** 2–4 anchors draw most arcs, an S or a swing; a loop or an orbit is a
  closed path.
- **The timing is one progress track,** 0 → 100 % of the path in 2 keys: the speed of the whole move changes in one
  place.
- **Linear progress is the default:** a constant speed along the curve (an orbit, a conveyor, a loop, a pass through
  the frame). Ease it on purpose when the layer starts from rest and lands. At a join the progress follows match
  velocity like any track; a layer that enters moving and stays in the shot also lands, or a matched start on a linear
  progress stops it dead at its last key.
- **Progress is not distance** in most tools: each segment between two anchors gets an equal share. Space the anchors
  evenly, or read the real speed on screen.
- **Aim** the layer along the path when it has a nose (an arrow, a plane, a cursor trail); keep cards, type and logos
  upright. **Several layers on one path** share the anchors and differ by an offset, so a formation holds. The camera
  sweeps or arcs on a path the same way.

In the editor: [video-paths.md](video-paths.md) (`motionPath` + `motionPathT`) and the camera's path in [video-camera.md](video-camera.md).

### Corners on a line: straight legs and one radius

A line with corners (a connector between cards, a route, a bracket, a flow-chart link) is straight legs joined by arcs
of one radius, set in px. Where the legs meet at angle φ (the turn θ = 180° − φ), put two anchors at `d = r / tan(φ/2)`
from the corner, one on each leg, each with a handle toward the corner of length `4/3 × tan(θ/4) × r` (0.5523 r for a
right angle). Cap `d` at half the shorter leg (a short leg gets a smaller radius, never an overlap), and give the legs'
anchors handles along the leg, so every leg stays straight.

- **Never a smooth tangent through the corner points** (Catmull-Rom, `(P[next] − P[prev]) / 6`). It is right for a free
  curve through points; at a sharp turn it overshoots past the corner and curls back into a hook, worse when the legs
  differ in length or the box scales x and y differently.
- **A leg drawn vertical or horizontal is exact:** snap its points to one x (or y) first; two points a few px apart make
  a long leg lean.
- **The radius is a design value:** read it from the reference, and use one radius on every corner of the film. In the
  editor: [video-shapes.md](video-shapes.md#writing-the-handles).

### Computed and measured motion: fit it, then write it

A solved pan, a zoom on the log scale, a counter-move that holds a layer on screen, a drift you measured: compute it as
densely as you like, then fit it to the fewest eased keys and write only those. A curve you computed exactly may miss
by what no viewer sees: position 1 px (0.5 px when two layers sit on each other), scale and zoom 0.3 % of the value
(relative, so ×1 and ×20 get the same care), rotation 0.2°, opacity 0.01.

- **A fitted curve stays inside what it fits.** Where the motion runs from one value to another without overshoot, so
  do the keys: a scale fitted from rest that dips 0.1 % under it opens an edge on a full-frame layer; an opacity goes
  below 0.
- **A measured track is fitted as moves, never through its samples.** A tracker scatters by ±1–5 px (hand-read seeds
  ±8–15 px), and keys on that scatter make the speed wobble though every key is "within tolerance". Smooth at the
  measurement's own noise, split where the motion stops, turns back, or changes pace, and write each move as 2 keys
  with one ease whose end speeds are the measured ones, the layer's tracks sharing their key frames. The stillness
  limit is that noise, never more; never hold a stretch in the middle of a track (the data jumps where it resumes).
- **Two layers that must stay locked** (a matte and its shape, a label and its card) get the same keys, or one is
  parented to the other: two separate fits agree only to the tolerance.
- **A counter-move takes its key times from what it cancels** (in the picture's plane, the parent's own keys with the
  opposite sign).
- **What does not fit is not a move:** a track that still needs more than half its per-frame keys is noise or steps.
  Leave tracked data as it is and name it.

### Joins: one move across the cut

A join is any change from one shot or scene to the next: a hard cut, a cross transition, a morph, a mask reveal, a
push. Layers arriving and leaving inside one scene are not joins. Every join reads as one continuous gesture, never
"stop, then start": on a crafted product film measured frame by frame, 30 of its 37 joins keep the direction of motion,
and at 29 the cut sits within ±2 frames of the move's peak speed.

- **Match velocity.** The outgoing shot accelerates into the cut; the incoming one starts already moving the same way
  and brakes, so the cut reads as the middle of one move. A join that stutters is wrong in speed, not in position: a
  curve's handle fixes it, not a new animation.
- **The curves.** Out: the last 12–25 f (0.4–0.8 s) on an ease-in still accelerating on its last frame, easeInQuart or
  easeInCubic (the editor's `Cubic In`, `Ease In`). In: the first 8–35 f on an ease-out that starts at speed,
  easeOutQuart, easeOutCubic or easeOutExpo (`Cubic Out`, `Ease Out`, `Expo Out`). Never a curve at rest at either end
  across a join (`Smooth`, `Natural`, `AE Smooth`, `AE In (arrive)`, `AE Out (leave)`, `Punch`), and never `Slow Down`
  on the incoming side: its start is a jump. **At a join this wins over [Easing by intent](#prefer);** inside a shot,
  away from a join, Easing by intent stands.
- **The speeds.** In: pan 1.0–1.3 × the out speed, zoom 1.2–2.0 × (the in side may start faster, never much slower),
  the same direction; the peak speed within ±2 f of the cut. A scale step on the cut may go ×0.5…×1.4 in the zoom's
  direction.
- **Direction first.** If the shot before moves down, the next one arrives moving down. A reversal fails unless it is
  the idea (a bounce on a beat) and the plan says so.
- **No dead holds, no cut onto a still or onto black.** Every shot keeps a slow drift (a log-zoom of ≥ 0.15 %/f, or a
  pan) so the next join has a speed to match. A hard cut from a moving card to a static frame reads too sharp: give the
  still side a drift, or carry the card off in the next shot's direction while the next scene dissolves in (the next
  line re-centres ← → the card flies ←; the next word rises ↑ → it flies ↑).
- **A hero never jumps.** An element on both sides keeps its centre and size (within 20–30 px, ×0.95–1.3) or moves by
  a visible eased move; everything else fades out 3–4 f before the cut.
- **No sharp jerks** ([Never](#never)). A small move (up to ~5°, ~5 % scale, ~40 px) takes 10–12 f or more with an
  ease, or goes: a ±1° camera roll in 5 f reads as a twitch. The exception is an accent the plan names: a whip on the
  beat, a snap or punch-in, the 1–2 jump frames of a fast pan across one big interface (with no motion blur there, so
  it stays readable). Before delivery, scan every layer's keys, the camera's roll and tilt included, for a step shorter
  than ~5 f that is neither.
- **A morph hides in a blur valley** of 4–8 f: no frame where both shapes read.
- **One trick per join:** one carrier (a move, an anchor, a shape, a colour). A whip, a flash and a glitch on one cut
  hide nothing and read as a template; effects nobody asked for (glow frames, a shockwave, multiply flashes) read as
  mistakes. The plainest join that carries the eye wins. Type uses the tool's per-word or per-letter presets, never
  stepped motion-blur ghosts.
- **A card finishes its action inside its stop** before the join starts: speed the screen up rather than cut it.
- **Change only what the join needs,** on the latest copy, and make a new version of someone's film unless told to
  edit it in place.

**Plan the joins before you build:** one line per join, `join · type · carrier · A end (position, scale, speed) ·
B start · length · curves`, where A is the end of the outgoing shot and B the start of the incoming one. A join with
neither a carrier nor a move is a plan error: add a drift, pick an anchor, or change the type.

**Two depths.** The smooth pass (every join matched, no pops, no stop-start) is the floor, and on its own it is hard to
see. A scene pass on the 3–5 joins with the biggest content change (a section change, words ↔ picture, one world to
another) changes the scenes themselves, carried by something the picture already shows: a button opens as a window
onto the next shot, a screen is pushed through, a surface's colour becomes the next background, the mark closes as an
iris. That is what a viewer sees.

- **Every film gets its own joins.** The carrier comes from this film's frames at this join, never from a list that
  worked elsewhere (a carrier back from another film reads as a template). No two scene joins of one film share both
  type and carrier kind, the brand mark opens or closes at most once per section, and scene joins alternate with plain
  cuts.
- **The seam ledger.** Keep the scene joins in the user's notes for the project or board (in the app, the board
  memory's "Scene seams used"), one line each: `film · join (time) · carrier · type · move · the user's verdict`. A new
  one differs from every entry in at least two of carrier, type, move (push, pull, slide, turn, fall, fold…) and
  shape. When nothing new fits, find a carrier kind nobody used, or leave a good smooth join; never a repeat.
- **Shapes must match** when one turns into another (a window landing in a device screen, a frame collapsing into a
  box): aspect ratio, corner radius, each edge on the same pixels, the turn. If they can't, don't morph: A leaves and
  B arrives, overlapping so no frame is empty, or B comes in under A's frame. B starts on what the window, screen or
  surface showed (the same backdrop, the same colour), with no fade from black and no flash.

### The twelve join types

| Type | What carries the eye | Use when |
|---|---|---|
| SR-01 Momentum cut | the motion (pan or zoom), cut on its peak | both sides move and nothing is shared: the default |
| SR-02 Anchor match cut | one element keeps its place while the world changes round it | the same word, caret, button, panel or product on both sides, its size within ±30 % |
| SR-03 Shape window / iris | a mark or shape opens onto the next shot, or closes the last | a section starts or ends: the same shape opens and closes it |
| SR-04 Morph in a blur valley | colour and centre | a word becomes the mark, the mark an object |
| SR-05 Shared element | the tile's box | a tile grows into the frame, or the frame shrinks into a tile of a grid |
| SR-06 Screen ↔ device | the screen's picture | the frame was a device's screen, or the camera pushes through one |
| SR-07 Shape / colour rhyme | colour and rectangles | A ends on shapes of one colour that become B's (highlights → blocks, a pill → a button) |
| SR-08 Type choreography | the letters, the line's place | a shot becomes a word of a line, letters regroup, UI is born in a word gap, a line pushes the next |
| SR-09 Crisp smash-pan | the plane of one large layout, no blur | moving inside one interface, started by a click (the move starts 1 f after it) |
| SR-10 Push-wipe / light change | a hard edge that wipes and pushes, or a band of light | two worlds with nothing in common |
| SR-11 Depth swap | depth: the old subject recedes, the new one rises into its place | the same, over one background |
| SR-12 Mark lockup | the mark slides or rolls aside, the wordmark appears from behind it | the end card, rhymed with the opening if the mark opened the film |

- **Most joins are SR-01 plus one other type:** the anchor or the rhyme carries the content change, the momentum
  carries the time.
- **One side still and nothing shared:** give it a drift and cut SR-01, share a shape or a colour (SR-07), or carry
  the old card off while the new scene dissolves in.
- **Rhythm.** Section changes sit in the voice-over's pauses, not on the beat; inside a section the joins follow the
  words (what is said is shown ~0.3 s later). Never three of the same non-momentum type in a row. The join with the
  biggest content change is the most visible one (SR-03 or SR-04); small steps inside a section are plain SR-01 cuts.
- **A film with no cuts** (one 3D world travelling between stops): its joins are the travels between two rests. A
  travel whose peak sits on the hand-over of the two cards already matches velocity, though it eases in and out.

### Check the motion before delivery

1. **Count the keys** on every track you wrote: 8 or more under ~0.4 s apart needs one of the reasons in
   [A move is two keys](#a-move-is-two-keys-and-an-easing); fit the rest.
2. **Where you fitted a curve,** compare it with the dense one on every frame: inside the tolerance.
3. **Where two layers must stay locked,** look at a frame between two keys, not only at the keys.
4. **No inner key stops or jolts** a move that goes on, on the layer or any of its parents, unless the design stops
   there.
5. **Each element the user will watch:** all its properties start on the same frame, no stop the design doesn't make,
   no turn where its angle holds.
6. **Every line with corners:** the curve turns no more than its anchors (no hook), and the straight legs are exact.
7. **Every join on a contact sheet,** a frame every 2 for 1.5 s on each side: the direction kept, no stop, no pop to
   black or white, the carrier readable on the join's first frame, no text of A under B's for more than 2 f, no
   layer's box edge showing. With ffmpeg, `T0` 1.5 s before the join (tile k is the frame at T0 + 2k/30 s):
   `ffmpeg -v error -ss T0 -t 3 -i film.mp4 -vf "select='not(mod(n\,2))',scale=480:-1,tile=6x8" -frames:v 1 sheet.jpg`
8. **With Python,** measure every join on the render and put its numbers in the report: [Seam Craft](seam-craft/README.md).
