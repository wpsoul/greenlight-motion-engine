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
  animation: video-projects.md, Text animation pace.

## Easing by intent

- Entrances: `AE Out` or `Expo Out` (fast start, soft landing). Camera and big moves: `AE Smooth`.
- A layer that passes through (in, glide, out): `Smooth Glide` with the `glide` expression — the Glide keyframe
  presets build it (video-keyframes.md).
- Playful arrivals: `Back Out` or `Overshoot`. Exits: `Ease In`.
- `Linear` only for constant motion: tickers, rotation, progress along a path.

## Text animation

- Animate words or letters, never a whole line at once — the text presets do this.
- One family per video. Calm presets for lines and captions: Glide Text (`glide-text`), Classic Fade Up
  (`classic-fade-up`), Classic Rise (Mask) (`classic-rise-mask`); Focus Type (`focus-type`) for a title.
- Punchy presets that tilt or overshoot — Swing Pop (`swing-pop`), Whip (`whip`), Letter Vortex (`letter-vortex`) —
  only on 1–3 words when the video wants energy. On a longer caption they read cheap.
- Glide Continuous (`glide-continuous`) and Glide Soft Stop (`glide-soft-stop`) never let the text rest: use them
  only when the user asks for drifting text.
- On a coloured card, pick a preset without a colour band (Classic Rise (Mask), Classic Fade Up): a band's colour can
  clash with the card.

## Transitions and camera

- Vary two or three kinds of transition across a video: one kind everywhere looks like a template, a new one at
  every cut looks random.
- Camera moves are slow and small unless they are the point. Fast motion looks best at 60 fps with motion blur.

## Sound

- A soft whoosh on each transition and on the first headline is a good base. `data-1` or `selection-data-click` for
  UI-like pops, `cinematic-transition-13` for one big reveal.

## What to check in every version

Look at real frames across the video (a contact sheet) before the user sees it — the JSON doesn't show these:
blank or empty frames, overlapping or cut-off text, text too small or gone too fast, nothing moving or everything
moving at once, weak hierarchy, clashing colours. Fix them and look again; two rounds are usually enough.
