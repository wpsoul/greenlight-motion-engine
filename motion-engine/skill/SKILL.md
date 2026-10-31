---
name: greenlight-motion
description: "Make motion-design videos for a user with the GreenLight Motion Engine — the GreenLight Dash Video Editor's own engine, running in the user's browser with nothing to install for them. Use when the user asks for an animated video, a promo, a product teaser, a title sequence, an explainer, kinetic typography, a 3D product shot, or a video template they can tweak themselves. You write a project (JSON) and its files; the engine gives the user a page with a preview, options to change, and a Render button that saves an MP4."
---

# GreenLight Motion Engine

You make the video as **data**: `project.json` (layers, timing, keyframes, effects, camera, 3D) plus the files it uses
in `assets/`. The engine — the same one the GreenLight Dash Video Editor renders with — turns that into:

- **a page the user double-clicks** (`index.html`): real-time preview, a scrubber, the options you exposed, and
  *Render MP4* (30/60 fps, motion blur), all in their browser;
- **one self-contained HTML file** (`pack`) to send around or put in a Claude artifact;
- **an MP4** you render yourself (`render`).

You never write UI or animation code. If something is not in the format, it is not in the engine — say so.

## Setup (once per machine)

```
npx greenlight-motion@0.2.2 doctor
```

It checks Node 18+, Chrome or Edge, WebGPU and H.264 encoding, and prints a fix for anything missing. Do not install
anything globally without asking the user. Always pin the version in every command you run.

## First, a direction

Before any JSON, decide in a few lines what the video LOOKS like: one visual idea from the subject's own world carried
through every scene, the palette, the type, and what each scene shows besides its words. Presets make a video move;
the direction makes it look designed. `skill/references/scene-script.md` opens with how. Then build to it, and judge
every contact sheet against it.

## The fast way: a scene script

For a new video, start with a **scene script** instead of a whole project: a short JSON file — scenes, their texts and
shapes, preset names, transitions, sounds — that `script` turns into `project.json` with the Video Editor's own
animation presets (the same converter the GreenLight Motion connector uses in Claude and ChatGPT). Hand-written
keyframes rarely look as good. The format, the design rules and the catalogues: `skill/references/scene-script.md`.

```
npx greenlight-motion@0.2.2 script <folder> --from scenes.json   # or write <folder>/script.json, then: script <folder>
```

Then `check` and `stills` (below), fix the SCRIPT and run `script` again — it rewrites `project.json`. A scene's
`camera` can be a real 3D camera (the editor's camera moves and rigs, zooms on spots, depth of field, layers in depth with
`z`). For what a script can't say (3D models, particles, motion paths, masks, text animators by hand), go on from `project.json` with the
workflow below and stop running `script` (it refuses to overwrite a project edited since, unless `--force`).

## Beyond the script: the signature visual

The script gives structure; the picture that makes the video THIS product's usually needs the engine's full format.
Build it with `apply` on the project `script` wrote (the item ids are the script's element ids):

- **A material of its own**: a custom GLSL shader on a shape or the whole background (water, light through glass,
  paper, heat): `shapeBackground` / `background` `{ "type": "shader", "shaderId": "custom", "shaderCode": "void
  mainImage(out vec4 o, in vec2 fc) { … }" }`, Shadertoy-style, `iTime` from the timeline
  (`references/video-backgrounds.md`, Custom GLSL shaders).
- **Layers that interact**: a track matte, so words dip under a surface or show only through a shape
  (`"trackMatte": { "sourceId": "<item>", "mode": "alpha" | "alphaInverted" | "luma" | "lumaInverted" }` on the layer
  that is cut; the source is hidden from the output; `references/video-shapes.md`). Clipping masks and Layer Mask
  (`references/video-effects.md`) for reveals.
- **Your own drawing and motion**: SVG you write (`{ "type": "image", "svg": "…" }` in the script), shapes with
  keyframes, motion paths (`references/video-paths.md`), particles (`references/video-particles.md`), 3D
  (`references/video-3d.md`), Text Animators by hand (`references/video-text.md`).
- **Sound when nothing may be downloaded**: write it in code. A short Node script can write a 48 kHz WAV (a soft bed, a
  click, a noise whoosh) into `assets/`, then use it as the script's `music` or as an audio clip. Keep the bed quiet
  under the hits.

Keep the build repeatable: put your edits in a file you `apply` again after each `script` run (`script --force`, then
`apply`), so the script and the hand-made layers never drift apart.

What the engine does there, so you don't learn it from a broken frame:
- **A shader on a shape** draws in that shape's own buffer: `iResolution` is the shape's size (times `shaderScale`), not
  the frame's, and `iTime` counts from the layer's own start, so layers whose shaders must stay in step need the same
  start. Its settings are not keyframe tracks: change it over time inside the code, from `iTime`.
- **A track matte's source** is hidden only while a layer that uses it is on screen; outside that time it draws as an
  ordinary layer. Give it the same start and end as the layer it cuts (`check` reports one that shows).
- **Fonts**: a text layer's family loads from Google Fonts while the page is online, unless a font file in `assets/`
  carries that name (`assets/Manrope.ttf` is the family "Manrope"; .ttf, .otf, .woff, .woff2): that file is used,
  offline. `trace` reads layers inside a script's scenes too (`--items` takes their ids).

## Workflow

1. `npx greenlight-motion@0.2.2 init <folder>` — starts from a working example (title, subtitle, accent line, four
   options). `--from file.json` starts from a project you have (for example one exported from GreenLight Dash).
2. Edit `<folder>/project.json` — for changes to an EXISTING project prefer `apply` (below): it checks every edit and
   applies all or nothing. Put pictures, video, sound and fonts in `<folder>/assets/` and refer to them as
   `"asset:<file>"` (e.g. `"url": "asset:product.png"`).
3. `npx greenlight-motion@0.2.2 check <folder>` — fix everything it lists (missing files, template mistakes, blank
   frames, page errors). `--json` for machine output.
4. `npx greenlight-motion@0.2.2 stills <folder>` — renders frames and **a labelled contact sheet**. Open and look at
   it before you go on: layout, readability, timing. Fix and repeat. `--at 0.5,1.2,3` for exact times.
5. Hand it over: tell the user to open `<folder>/index.html` (Chrome or Edge), or `pack` it into one file, or
   `render` the MP4 yourself (`--fps 60 --motion-blur` for fast motion).

`set <folder> key=value …` changes template values the same way the page's options panel does.
`apply <folder> edits.json` (or `-` for stdin; `--dry-run`, `--json`) applies a LIST of edits atomically: each is
checked (the item/clip/channel exists — nested sequences included —, a value keeps its type, ids stay unique, and after
the batch every clipId, parent, sound anchor and template target still resolves); one bad edit → nothing is written and
the error names the edit number with a fix. Ops:
```json
[{ "op": "set", "item": "title", "path": "textContent", "value": "Launch day" },
 { "op": "set", "project": true, "path": "videoSize.w", "value": 1080 },
 { "op": "unset", "item": "title", "path": "propertyKeyframes.opacity" },
 { "op": "keyframe", "item": "accent", "track": "translateX", "at": 50, "value": 120, "easing": "Power2.easeOut" },
 { "op": "add", "to": "clips", "value": { "id": "c9", "mediaType": "image", "url": "asset:a.png", "duration": 4 } },
 { "op": "add", "to": "channels", "value": { "id": "ch9" }, "at": 0 },
 { "op": "add", "to": { "channel": "ch9" }, "value": { "id": "it9", "clipId": "c9", "trimStart": 0, "trimEnd": 4 } },
 { "op": "add", "to": { "item": "it9", "list": "effects" }, "value": { "id": "bloom", "eid": "fx-1", "params": {} } },
 { "op": "add", "to": "sounds", "value": { "sfx": "standard-swoosh", "on": "it9", "at": "peak" } },
 { "op": "remove", "effect": "fx-1", "item": "it9" },
 { "op": "move", "channel": "ch9", "to": 0 }]
```
(`keyframe` `at` is the position in the layer, 0–100 %; `remove` takes `item`, `channel`, `clip`, `sound` (index) or
`effect` + `item`; `move` `to` is the stack position, 0 = bottom.)
`trace <folder> [--fps 30]` writes `trace.json`: every keyframed layer's animated values frame by frame (the engine's own
curves) and its moments — start, end, `peak` (the fastest instant) and when each track settles. Use it to check
timing and staggers in numbers instead of guessing from stills, and to place sound cues.

## The project format — essentials

It is the GreenLight Dash Video Editor's format. Any field you leave out gets the editor's default (the engine runs the
editor's own normalizer), so write only what you mean.

```json
{
  "videoSize": { "w": 1920, "h": 1080 },
  "background": { "type": "solid", "solidColor": "#0f1418" },
  "clips":    [ { "id": "c1", "mediaType": "text", "name": "Title", "duration": 4 } ],
  "channels": [ { "id": "ch1", "items": [ { "id": "title", "clipId": "c1", "textContent": "Hello", "panY": -5,
                  "propertyKeyframes": { "opacity": [ { "position": 0, "value": "0", "easing": "Ease Out" },
                                                     { "position": 25, "value": "1", "easing": "Linear" } ] } } ] } ]
}
```

- **clips** are the sources (`mediaType`: `text`, `shape`, `image`, `video`, `audio`, `camera`, `model3d`, `particles`,
  `adjustment`, `sequence`…); **items** place a clip on a channel (one track) and carry everything about how it looks.
  Items on one channel play one after another; put layers that overlap in time on separate channels.
- **Timing lives on the item.** `trimStart` / `trimEnd` (seconds into the clip) set how long the layer shows — set
  `trimEnd` on every item, or a text or shape layer runs the editor's default 5 s. Items on one channel play back to
  back; to start a layer later, set `"freeStart": <seconds>` on the item and `"unsnapped": true` on its channel.
  The clip's `duration` is only the source length. Never let two items on one channel overlap in time.
- Position: `panX` / `panY` = % of the frame from the centre (±50 = the edge; +Y is down). Size: `zoom`, `scaleX`,
  `scaleY`. `rotation` degrees, `opacity` 0–100 on the item.
- Keyframes: `propertyKeyframes.<track>` = keys with `position` **0–100 % of the clip's duration**, `value` **as a string**,
  and an `easing` name that shapes the segment after the key. Tracks: `opacity` (0–1 here), `scale`, `scaleX`,
  `scaleY`, `rotate`, `xPercent`, `yPercent`, `translateX/Y/Z`, `textColor`, `shapeFill`, `blur`, … (references below).
- Text: `textContent`, `textColor`, `textFontSize` (px at the composition size), `textFontWeight`, `textFontFamily`,
  `textAlign`, `textLetterSpacing`, `textLineHeight`. Shapes: `shapeType`, `shapeFillColor`, `shapeWidthPct`,
  `shapeHeightPct`, `shapeRadiusPct`.
- Not here: MotionFast templates (`mediaType: "motion"`) live only in GreenLight Dash — build the look from layers.

Full references (generated from the editor's own docs; ignore the `/api/` routes they mention):
`skill/references/` — video-design, scene-script, video-projects, video-text, video-text-kinetic, video-text-presets, video-shapes, video-keyframes,
video-camera, video-3d, video-effects, video-transitions, video-particles, video-paths, video-backgrounds, video-grid.
Machine-readable lists: `npx greenlight-motion@0.2.2 schema effects | transitions | easings | paths | expressions`.

## Template

The options the user can change on the page. Expose the things a user would want to change (headline, names, colours,
the product picture, a number) and nothing that can break the design.

```json
"template": {
  "title": "Product teaser",
  "fields": [
    { "key": "headline", "label": "Headline", "type": "text",   "targets": [ { "itemId": "title", "path": "textContent" } ] },
    { "key": "accent",   "label": "Accent",   "type": "color",  "targets": [ { "itemId": "line", "path": "shapeFillColor" } ] },
    { "key": "photo",    "label": "Product photo", "type": "image",
      "targets": [ { "clipId": "c-photo", "path": "url" }, { "clipId": "c-photo", "path": "proxyUrl" } ] },
    { "key": "size",     "label": "Title size", "type": "number", "min": 60, "max": 200, "step": 2,
      "targets": [ { "itemId": "title", "path": "textFontSize" } ] },
    { "key": "bg",       "label": "Background", "type": "color", "targets": [ { "path": "background.solidColor" } ] }
  ],
  "values": { "headline": "Launch day" }
}
```

Types: `text`, `color`, `image`, `number` (`min`, `max`, `step`), `select` (`options: [{ value, label }]`), `toggle`.
A target is an item (`itemId`, found in nested sequences too), a clip (`clipId`) or the project (neither), plus a dot
`path`. One field may change several targets. `check` reports fields that point at nothing.

## Sound

Give motion its sound with **cues**, not seconds: `"sounds"` at the top of project.json. Each cue lines a sound's
own sync point (its loudest moment: a click's contact, a whoosh's pass, a hit) up with an event of a layer, so
retiming the layer moves its sound with it:

```json
"sounds": [
  { "sfx": "standard-swoosh",         "on": "card", "at": "peak" },
  { "sfx": "cinematic-transition-13", "on": "logo", "at": "start", "gain": -2 },
  { "sfx": "data-1",                  "on": "badge", "at": "start" },
  { "sfx": "selection-data-click",    "time": 3.2, "gain": -6 }
]
```

`at`: `start`, `end`, `peak` (the layer's fastest moment, from its keyframes) or seconds from its start; `time` for
an absolute moment; `align` `sync` (default) / `start` / `end`; `offset` seconds; `gain` dB (≤ 0).

The library is 77 hand-picked sounds in categories (whooshes and swooshes, transitions, clicks, pop-ups and
notifications, data blips, typing and writing, foley, bubbles, impacts and bass drops, camera, gears, voice clips).
`npx greenlight-motion@0.2.2 schema sounds` lists every one with its `category`, `use` (what it is for), `duration`
and `sync`. Pick by `category` and `use`, then by name.

- **Where the files come from:** the GreenLight sound CDN. `build` downloads each sound a cue uses into
  `assets/sounds/` (once, so the finished folder plays offline); `check` reports a sound it could not get, with the fix.
- **Voice clips & memes** are real voices, some of real people: only when the user asks for one.

Fewer is better: one sound per meaningful event, whooshes only on big fast moves, nothing under spoken words. A
sound never makes the video longer. The page and the rendered MP4 play them; `check` reports a cue it can't place.

## Review notes from the user

The page has **Notes**: the user marks what should change right on the frame (a pin, a box, an arrow or a drawing)
and writes a note for each mark. Every note carries the moment (seconds and frame), the mark in composition pixels
and the layers under it (item ids in project.json), so you change exactly that and nothing else.

- **They review on this computer:** run `npx greenlight-motion@0.2.2 review <folder>` and give them the URL it prints
  (it keeps running; `--open` opens their browser, only when they ask). Their notes land in `<folder>/review/`: read
  `review/NOTES.md`, look at the `at-<t>s.png` pictures (the marks are numbered), make the changes (`apply`), `build`
  again and tell them to reload the page.
- **They opened the page from a file:** **Save notes** gives them `<title>-notes.zip` (NOTES.md and the pictures) to
  hand you, and **Copy for agent** puts NOTES.md on the clipboard.
- **In a Claude artifact:** publish with `capabilities: { downloads: true, comments: { customAnchors: true } }`. Each
  mark then opens the claude.ai comment box at that spot; the user writes the note and presses **Send to Claude**.
  The comment's location reads `12.40s · <layer name> · box x,y wxh` (`pin x,y`, `arrow x,y` = its tip) and its
  detail names the frame and the layer ids under the mark: fix that, republish, and answer in the thread.

## Plugins: an effect or transition that isn't in the catalog

Write it as a package — GreenLight Dash's own format, so the same file installs in the app:
`skill/references/plugins/` has the starters (`starter-effect-tsl.js`, `starter-effect-passes.js`,
`starter-transition.js`) and their contracts. Save it as `assets/plugins/effects/<id>.js` or
`assets/plugins/transitions/<id>.js` (the file name is the package's `id`), then use it like a built-in:
an item's `effects` entry `{ "id": "local:<id>", "eid": "…", "enabled": true, "mix": 100, "params": { … } }`, or a cross
transition `"transition": "local:<id>"` with `transitionDuration` and `transitionOptions`. The engine draws on WebGPU,
so write the TSL form (`renderer: 'webgpu'`). `check` compiles and draws every package and reports the error of one
that fails (`plugin`); look at `stills` for the look. A package that carries its own images or videos is a folder:
`assets/plugins/effects/<id>/effect.js` (or `transitions/<id>/transition.js`) plus its files under
`assets/plugins/effects/<id>/assets/` — an effect's `textures` (`file: 'assets/grain.png'`) and a transition's
`TRANSITION_ASSETS['glass.webm']` then load from the page, exactly as in GreenLight Dash.

## GreenLight Dash

The same project opens in GreenLight Dash (the desktop editor this engine comes from) for full editing: the page's
edit note offers **Open in GreenLight Dash** (it imports the folder as a new project on the open board; a page with
changes saves a `.glvideo`). `npx greenlight-motion@0.2.2 pack <folder> --glvideo` writes that file yourself: ONE
`.glvideo` (the project + its files) that opens in GreenLight Dash on a double-click, or dropped on its board. Hand it
over when the user wants to keep editing in the app. A
GreenLight Dash project comes the other way through the app's **Export for agents** — a ready folder like the one
`init` makes, with the options the author ticked. `npx greenlight-motion@0.2.2 init <folder> --from <its project.json>`
starts from one too. Never tell the user they must install it: the page plays, changes options and renders on its own.

## Files

Everything in `assets/` is available under `asset:<path>`. Two folders have fixed meanings: `assets/models/<file>.glb`
supplies the 3D device presets, `assets/hdr/<name>.hdr` the 3D lighting environments. You don't put those there
yourself: `build` downloads the presets (`"url": "model-preset:<id>"`) and environments a project uses from the
GreenLight CDN, once. `check` names any file the project or the engine asked for and did not get.

## Preferred transitions and effects

When the user has not named one, choose from these first. Each still has to suit the shot.

- **Cross transitions** (`transition`): `Cross Fade`, `Advanced Zoom`, `Advanced Movement`, `Circular Wipe`,
  `Pixel Blocks`, `Camera Whip`, `Zoom Ruler`, `Gradient Glow Stack`, `Gradient Map`.
- **Overlay Effects** (`effects[].id`): `ascii`, `bloom`, `colorama`, `crtMatrix`, `doubleExposure`, `echo`,
  `edgeDetect`, `extract`, `fastBlur`, `fastCameraWiggle`, `fill`, `filmStock`, `gradientBeam`, `gradientSweep`,
  `halftone`, `lightRays`, `pixelate`, `radialFastBlur`, `rgbSplit`, `shapeRulers`, `timeshift`.
- **Layer Effects** (`layerEffects[]`): `runningGlow`, `motionBlur`, `motionTrail`, `autoFill`, `repetile`,
  `regionDistort`, `cornerPin`, `rig`, `droste`, `glass`, `chromaKey`, `layerMask`.
- **Leave out unless asked:** `grain`, `lensPrism`, `linesDraw`, `sdfLensBlur`.
- **Text animation presets** (`references/video-text-presets.md`, `references/video-text-kinetic.md`): Glide Text,
  Ember Type, Marker, Outline Pass, Neon Flow, Glitch; Kinetic: Swing Pop, Pendulum, Fan Deal, Whip, Word Swing,
  Letter Vortex; Voice: Spoken Box, Spoken Pop, Spoken Glow, Karaoke Wipe, Word Pop, Rise on Voice,
  Typed as Spoken. Pick the category first (what the text should do), then prefer these within it.

## Motion design that looks made, not generated

Read `skill/references/video-design.md` before the first version and check every version against it: one idea per
scene, words on screen, hierarchy, timing, easing by intent, text animation picks, transitions, camera, sound and what
to look for in the contact sheet. It is the same text GreenLight Dash's agents and the chat connector use.
