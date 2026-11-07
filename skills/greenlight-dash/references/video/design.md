# Motion design that looks made, not generated

What makes a video read as designed rather than generated. The rules hold however the video is built — a project
through the app's API, `project.json` with the engine's CLI, or a scene script — so read them before the first version
and check every version against them.

## Story and words

- **One idea per scene**: 3–6 scenes of 2–3 s for a short video. A scene that says two things says neither.
- **At most ~8 words on screen at once, held at least 1 s.** People read about 3 words a second; text that leaves
  before it is read is noise.
- **9:16**: bigger text, stacked vertically, everything in the middle 80 %.

## Hierarchy

- One headline per scene; supporting text much smaller. Hierarchy comes from size and weight, not colour alone.
- One accent colour and strong contrast.
- **No text shadows unless the user asks for one.** A shadow under type reads as a stock default and softens the
  letter edges. When text has to read over footage or a busy picture, get the contrast from the design instead: a
  calmer or darker part of the frame, a caption bar (`textBgEnabled`), or a shape behind the text. So no
  `textShadowX` / `textShadowY` / `textShadowBlur` / `textShadowSpread` on a text layer, no `shadow` property in a
  Text Animator and no `longShadow` effect on text. A shadow already in the user's project stays.
- Keep text inside the middle 80 % of the frame (in a project: |panX| and |panY| ≤ 40): players and feeds crop the
  edges.

## Timing

- Stagger related elements by 0.06–0.12 s.
- **One focal move at a time.** If everything moves, nothing reads: supporting elements move less and later.
- Shapes and pictures enter in 0.4–0.8 s; exits are faster than entrances.
- A text animation takes at least 0.8–1 s over the whole line, first unit in to last unit settled, unless the video
  needs snap (a beat hit, a glitch flick): faster text flashes past before it is read. The arithmetic per kind of
  animation: [Text animation pace](#text-animation-pace).

## Easing by intent

- Entrances: `AE In (arrive)`, `Expo Out` or `Power` (fast start, soft landing); UI panels and drawers: `Apple Out`.
  Camera and big moves: `AE Smooth`.
- Scene changes on the beat, a logo hit, a screen swipe: `Punch` (slow wind-up, hard hit, long tail).
- A layer that passes through (in, glide, out): `Smooth Glide` with the `glide` expression — the Glide keyframe
  presets build it ([keyframes.md](keyframes.md)).
- Playful arrivals: `Back Out` or `Overshoot`; a real spring: the `spring` expression (Snappy for buttons, icons and
  pop-ins, Gentle for mascots, big cards and the camera). Exits: `Ease In` or `AE Out (leave)`; the Kinetic recipes'
  `Anticipate` exits (wind back, then snap away) are the exception and stay as tuned.
- `Linear` only for constant motion: tickers, rotation, progress along a path.

## Text animation

- Animate words or letters, never a whole line at once — the text presets do this.
- One family per video. Calm presets for lines and captions: Classic Fade Up (`classic-fade-up`), Classic Rise (Mask)
  (`classic-rise-mask`), Glide Text (`glide-text`); Focus Type (`focus-type`) for a title. All are in
  [text-presets.md](text-presets.md).
- Punchy presets that tilt or overshoot ([text-kinetic.md](text-kinetic.md): Swing Pop (`swing-pop`), Whip (`whip`),
  Letter Vortex (`letter-vortex`)…) only on short titles, hooks and calls to action — up to about 5 words, or 2–4 short
  stacked lines — and only when the video wants energy. On a longer line or a caption under speech they read cheap.
- Glide Continuous (`glide-continuous`) and Glide Soft Stop (`glide-soft-stop`) never let the text rest: use them
  only when the user asks for drifting text.
- On a coloured card, pick a preset without a colour band (Classic Rise (Mask), Classic Fade Up): a band's colour can
  clash with the card.

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
  ([text.md](text.md)).
- **Layer entrances and exits** on a text layer: `transitionInDuration` / `transitionOutDuration` of 0.8 or more
  (the most they take is 3 s).
- **Recipes** from [text-kinetic.md](text-kinetic.md) and [text-presets.md](text-presets.md) keep their tuned timing.
  On very short text (one or two words), where the span works out under 0.8 s, raise `duration` until it reaches 0.8 s.

Go faster only when the edit really needs it: the user asks for snappy or fast text, a word hits on a beat or a fast
cut, a glitch or scramble flicks, the layer is too short to fit a 0.8 s move, or the animator uses `drive: "voice"`
(the speech sets the pace there).

## Transitions and camera

- Vary two or three kinds of transition across a video: one kind everywhere looks like a template, a new one at
  every cut looks random.
- Camera moves are slow and small unless they are the point. Fast motion looks best at 60 fps with motion blur.
- A real 3D camera earns its place on one or two moments, not every scene: a zoom onto the one thing a scene is about
  (a number, the button a screen recording clicks; 1.3–2×, then back out), or a slow orbit or push that shows depth.
- Depth needs layers at different distances: a soft shape or picture far behind, the words at the front. Depth of
  field reads only then; keep the words sharp.
- Keep an orbit in front of flat layers (within about ±70°): text turned further goes edge-on, then mirrored.

## Sound

- A soft whoosh on each transition and on the first headline is a good base. `data-1` or `selection-data-click` for
  UI-like pops, `cinematic-transition-13` for one big reveal.
- Take sound effects from the user's Sound Library first
  ([media.md](../media.md#asset-libraries-sound--assets--music)). The ids above are GreenLight Motion library sounds, not
  Sound Library files: `GET /api/motion-sounds/v1/<id>.wav` serves one (e.g. `/api/motion-sounds/v1/data-1.wav`). Save
  it into the board folder and use the board url as an `audio` clip's `url`.

## What to check in every version

Look at real frames across the video (a contact sheet) before the user sees it — the JSON doesn't show these:
blank or empty frames, overlapping or cut-off text, text too small or gone too fast, nothing moving or everything
moving at once, weak hierarchy, clashing colours. Fix them and look again; two rounds are usually enough.
