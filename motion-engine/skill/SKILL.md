---
name: greenlight-motion
description: "Make motion-design videos for a user with the GreenLight Motion Engine — the GreenLight Dash Video Editor's own engine, running in the user's browser with nothing to install for them. Use when the user asks for an animated video, a promo, a product teaser, a title sequence, an explainer, kinetic typography, a 3D product shot, or a video template they can tweak themselves. You write a project (JSON) and its files; the engine gives the user a page with a preview, options to change, and a Render button that saves an MP4. A video asked for in the user's own words runs as the free Motion Design ▸ Custom workflow (motion-film / custom) on the greenlight MCP server when it is connected."
---

# GreenLight Motion Engine

You make the video as **data**: `project.json` (layers, timing, keyframes, effects, camera, 3D) plus the files it uses
in `assets/`. The engine — the same one the GreenLight Dash Video Editor renders with — turns that into:

- **a page the user double-clicks** (`index.html`): real-time preview, a scrubber, the options you exposed, and
  *Render MP4* (30/60 fps, motion blur), all in their browser;
- **one self-contained HTML file** (`pack`) to send around or put in a Claude artifact;
- **an MP4** you render yourself (`render`).

You never write UI or animation code. If something is not in the format, it is not in the engine — say so.

## A video from the user's words: the free Motion Design ▸ Custom workflow

When the user asks for a video in their own words, make it through GreenLight's free workflow **Motion Design ▸ Custom**
(Build New Video by Prompt): workflow `motion-film`, variant `custom`, on the `greenlight` MCP server
(`https://mcp.greenlightdash.pro/mcp`; this plugin connects it). It needs no account and no sign-in. Its steps come from
the server and drive this CLI, with the user's approvals on the way. Not when they hand you a project or a scene script
to change, ask to change the video you are making, or say to build it directly: then go on with this guide. In a
GreenLight Dash terminal (`$GL_MCP_CALL` is set) the board's own skill runs workflows instead, with `env: "app"`.

1. **Is it connected?** Its tools are there: `list_workflows`, `get_workflow`, `validate_brief`, `start_workflow`,
   `get_step`, `get_reference`, `get_files`, `report_step` (in Claude Code `mcp__plugin_greenlight-motion_greenlight__…`
   from this plugin, `mcp__greenlight__…` when added by hand; deferred tools: load them first).
2. **Write the brief from their words.** `product.about` is what they asked for, in their words; add `product.name`,
   `product.url`, `film.format` (`16:9`, `9:16`, `1:1`) and `film.language` when they say them, and their pictures and
   clips as `product.assets` (`{ url, name, type }` each). Leave out `output` (here: a GreenLight Motion project made
   with this CLI) and `variants` (several built ideas: PRO). `validate_brief { "id": "motion-film", "variant":
   "custom", "brief": … }`: fix its errors, decide an `open` field yourself when the request implies it or its default
   fits, and ask the user the rest in one message.
3. **Run it.** `start_workflow { "id": "motion-film", "variant": "custom", "env": "standalone", "capabilities":
   ["fs","shell"], "brief": … }`, then each step in order: `get_step`, what it names (`get_reference`, `get_files`),
   the work, `report_step`. The first step checks this computer, and the run waits until it passes. Stop at every
   approval step until the user answers. The steps say which commands to run (keep to the engine version they name for
   the whole run); this guide is how to do each one well.
4. **A result with `ok: false`** (a limit, a choice that needs PRO, the server down) is for the user: tell them its
   message and offer to go on with this guide.
5. **Not connected** (no such tools): say once how to connect it, and offer to make the video without it.
   - Claude Code: this plugin brings it. By hand:
     `claude mcp add --transport http greenlight https://mcp.greenlightdash.pro/mcp`, then a new session.
   - Codex: `codex mcp add greenlight --url https://mcp.greenlightdash.pro/mcp`.

   Without it, make the video with this guide alone, as below, and don't ask again.

**A ready template** (Feature Overview, Logo animation, Screen tutorial, Rebuild video by style …) is a GreenLight Dash
PRO workflow on the same server: `list_workflows` shows each one's tier, where it runs and a preview. Say so in one line
and offer Custom. Only these ask the user to sign in, with their PRO account: in Claude Code `/mcp` → greenlight →
Authenticate (from a shell `claude mcp login plugin:greenlight-motion:greenlight`, or `claude mcp login greenlight` when
added by hand); in Codex `codex mcp login greenlight`. Their browser opens greenlightdash.pro: log in, press Allow.

## Setup (once per machine)

```
npx greenlight-motion@0.5.8 doctor
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
npx greenlight-motion@0.5.8 script <folder> --from scenes.json   # or write <folder>/script.json, then: script <folder>
```

Then `check` and `stills` (below), fix the SCRIPT and run `script` again — it rewrites `project.json`. A scene's
`camera` can be a real 3D camera (the editor's camera moves and rigs, zooms on spots, depth of field, layers in depth with
`z`). For what a script can't say (3D models, particles, motion paths, masks, text animators by hand), go on from `project.json` with the
workflow below and stop running `script` (it refuses to overwrite a project edited since, unless `--force`).

**3D in a video is GreenLight Dash's own 3D Scene: the script's `world`** — for any shot that is 3D (a product, a device, a
room, a logo or title in depth, abstract forms, a camera moving through space), not only a product on a table. You model
what the shot needs yourself: objects built from ops, materials (glass, liquids, metals, procedural patterns), lights, the
environment (`scene.env`) and `scene.camera` or a ready move; Draft as it plays, Final (path traced) for the render. A device
the brief names that is among the bundled presets (iPhone 17 Pro Max `iphone_pro_max`, iPhone Air `iphone_air`, two iPhones
`double_iphone`, iPad `ipad`, iPad mini `ipad_mini`, MacBook Pro `macbook_pro`, MacBook Air `macbook_air`, iMac `imac`) may be
taken ready-made: after `script`, add to `project.json` a `model3d` layer with `"url": "model-preset:<id>"`
(`references/video-world3d.md`, a device from the preset table: the clip, its own channel and `model3dConfig`, with an example;
its screen picture in `screen`, `{ "url": "asset:<file>", "fitMode": "cover" }`); it stands in the Scene's world — lit by it,
path traced in Final, its screen artwork kept. Model a device yourself, or use another model, only when the brief asks for
it. A `model3d` layer or a camera layer on a flat comp with no `world` is not how 3D is done. `script` checks the `world` strictly: a field the 3D engine
would ignore fails with its path and the right name. Format and example: `skill/references/scene-script.md` (A 3D Scene); every field, op and material:
`references/video-world3d.md` and `references/world3d-schema.json`. A folder with a Scene plays from a local server
(`review`), not by double-click; `check`, `stills` and `render` open it that way themselves. Keep Final short (seconds per
frame) and judge glass and liquids in a Final still: Draft shows no liquid inside glass. The 3D engine is a plugin,
`greenlight-motion-3d`: the CLI downloads it by itself the first time a folder has a `world` (once, into the user's cache);
`npx greenlight-motion@0.5.8 add-3d` gets it ahead, `doctor` shows it. Never tell the user to install it.

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
- **A shader on a shape** draws into its own buffer, at most 1280 px on its long side (the project background's: 2048),
  and `iResolution` is that buffer's size, not the frame's or the shape's: a full-frame 1920×1080 shape renders at
  1280×720, and a small shape's buffer can differ between preview and export. So compute in `fragCoord / iResolution.xy`
  (0–1 across the shape), never in frame pixels. `iTime` counts from the layer's own start (the background's is the
  timeline's), so layers whose shaders must stay in step need the same start. Its settings are not keyframe tracks:
  change it over time inside the code, from `iTime`.
- **A track matte's source** is hidden only while a layer that uses it is on screen; outside that time it draws as an
  ordinary layer. Give it the same start and end as the layer it cuts (`check` reports one that shows).
- **Fonts**: a text layer's family loads from Google Fonts while the page is online, unless a font file in `assets/`
  carries that name (`assets/Manrope.ttf` is the family "Manrope"; .ttf, .otf, .woff, .woff2): that file is used,
  offline. `trace` reads layers inside a script's scenes too (`--items` takes their ids).

## Workflow

1. `npx greenlight-motion@0.5.8 init <folder>` — starts from a working example (title, subtitle, accent line, four
   options). `--from file.json` starts from a project you have (for example one exported from GreenLight Dash).
2. Edit `<folder>/project.json` — for changes to an EXISTING project prefer `apply` (below): it checks every edit and
   applies all or nothing. Put pictures, video, sound and fonts in `<folder>/assets/` and refer to them as
   `"asset:<file>"` (e.g. `"url": "asset:product.png"`).
3. `npx greenlight-motion@0.5.8 check <folder>` — fix everything it lists (missing files, template mistakes, blank
   frames, page errors), and read its notes: text the engine wraps where you did not break it. `--json` for machine output.
4. `npx greenlight-motion@0.5.8 stills <folder>` — renders frames and **a labelled contact sheet**. Open and look at
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
 { "op": "keyframe", "item": "accent", "track": "translateX", "at": 50, "value": 120, "easing": "Ease Out" },
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
`events <folder> [--fps 30]` writes `events.json`: the film's event timeline, with no browser and no render — each move's
fastest frame (`move`, with its part: `travel`, `size` or `spin`) and the frame it comes to rest (`stop`, `gone` when it
shrinks to nothing), appearances, cuts, transitions, each Text Animator letter's start (`text`), and in a 3D Scene its
objects, camera, `visible` switches, lights and sims (read by the 3D plugin). Each event has `t`, `frame`, `strength`
(0–1) and where it is on the frame (`x`, `y`, `pan`). A cue's sound goes on these frames: a whoosh's loudest moment on a
`move`, a hit's on a `stop`, ticks on the first `text` letter.

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
video-camera, video-3d, video-effects, video-transitions, video-particles, video-paths, video-backgrounds, video-grid,
video-world3d (the 3D Scene, with world3d-schema.json); video-world3d-notes and video-motion-notes (what real films taught:
wrong ways and the right one, with values; read them before you build); video-motion-grammar-examples (the films behind the
motion grammar's rules), video-motion-in-code (its rules in a film made in code); `seam-craft/` (Seam Craft: the joins by
recipe and by numbers, with Python tools).
Machine-readable lists: `npx greenlight-motion@0.5.8 schema effects | transitions | easings | paths | expressions`.

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
`npx greenlight-motion@0.5.8 schema sounds` lists every one with its `category`, `use` (what it is for), `duration`
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

- **They review on this computer:** run `npx greenlight-motion@0.5.8 review <folder>` and give them the URL it prints
  (it keeps running; `--open` opens their browser, only when they ask). They mark notes and highlights and press
  **Save for agent**: their notes land in `<folder>/review/` (the server prints a `saved:` line). Read `review/NOTES.md`,
  open each note's picture beside it (`A-at-<t>s-n<note>.png`: the frame with their drawing), make the changes (`apply`),
  `build` again and tell them to reload the page. `notes.json` is the same as data, in one format for one film or several
  (`kind: "review"`, its `films` list). A folder with a render newer than its project.json plays the render (`--live`:
  the project, with Edit). Several versions go in ONE page (below).
- **They opened the page from a file:** **Save notes** gives them `<title>-notes.zip` (NOTES.md and the pictures) to
  hand you, and **Copy for agent** puts NOTES.md on the clipboard.
- **In a Claude artifact:** publish with `capabilities: { downloads: true, comments: { customAnchors: true } }`. Each
  mark then opens the claude.ai comment box at that spot; the user writes the note and presses **Send to Claude**.
  The comment's location reads `12.40s · <layer name> · box x,y wxh` (`pin x,y`, `arrow x,y` = its tip) and its
  detail names the frame and the layer ids under the mark: fix that, republish, and answer in the thread.

### Several versions: ONE review page

When you made several versions or variants (other looks, pacing, endings), never show them one page each: put them in
ONE review page, the same review card GreenLight Dash shows on a board, and ask the user to highlight, note and pick there.

```
npx greenlight-motion@0.5.8 review <a> <b> <c> --titles "Bold,Calm,Neon" [--subs "bigger type,slower,glow"]
```

Every folder is a source (A, B, C …, keys 1–9) on one shared timeline (frame n is the same moment in each):
**Highlight** = the parts they like from any version, in the order of a new cut; **Notes** = drawings and words on any
version's frames and ranges; **Pick** (top bar) = the version to go on with, or a mix, with a note. A folder whose MP4
is newer than its project.json plays that render (smooth, exactly what they get: `render` each version first when you
can), else its live project (`--live`: every project live). A scene script's scenes show as the version's parts. Start
it in the background, give them the URL and one line: highlight, note, pick, then **Save for agent**.

Save writes `<first folder>/review/` (`--out <dir>` for another) and the server prints a `saved:` line. Read
`review/NOTES.md`: the pick, then per version its notes (moment, part, layers on screen, picture) and highlights
(frames and seconds, ★ must), and the new cut in order; `notes.json` is the same as data (`kind: "review"`, each film's
key → its folder).
A note's picture, `<key>-at-<t>s-n<note>.png` beside it, is that version's frame with their drawing. Go on with the pick
(a mix: as its note says), make each note's change in that version's folder, build a cut from the highlights in their
order, then show the new version(s) in a new review page.

### Pictures to choose from: the pick page

When you generated several candidates for each frame or shot (stills, start frames, illustrations) and the user should
choose before you build on them, don't choose yourself: put each frame's pictures in a subfolder (`<dir>/<frame>/*.png`,
`.jpg`, `.webp`) or list them in `<dir>/pick.json` (`{ "title": "…", "frames": [{ "frame": "S01", "title": "the cold
open", "files": ["S01/a.png", "S01/b.png"] }] }`), then:

```
npx greenlight-motion@0.5.8 pick <dir> [--title "Teaser stills"]
```

It is GreenLight Dash's pick card: a click picks a frame's **take** (the picture to use), more clicks add **extras**,
a note per frame. Save writes `<dir>/PICKS.md` (`S01 = take S01/b.png · extras S01/a.png`, then their note) and
`PICKS.json`. Build each frame on its take (an extra too, or instead when the take fails: say so); never a picture they
did not pick for that frame, and don't generate it again unless its note asks; a frame not picked is yours to choose.

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
changes saves a `.glvideo`). `npx greenlight-motion@0.5.8 pack <folder> --glvideo` writes that file yourself: ONE
`.glvideo` (the project + its files) that opens in GreenLight Dash on a double-click, or dropped on its board. Hand it
over when the user wants to keep editing in the app. A
GreenLight Dash project comes the other way through the app's **Export for agents** — a ready folder like the one
`init` makes, with the options the author ticked. `npx greenlight-motion@0.5.8 init <folder> --from <its project.json>`
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
Before you plan the joins and the moves, read its motion grammar (`video-design.md`, Motion grammar); check the joins by
numbers with Seam Craft (`skill/references/seam-craft/`) only where Python 3 with OpenCV runs on this computer, and in a
chat with no computer follow the rules alone.
