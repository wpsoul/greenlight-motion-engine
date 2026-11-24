# The scene script — the fast way to a video that looks made

A short JSON script — scenes, their texts and shapes, preset names, transitions, sounds — that
`npx greenlight-motion script <folder>` turns into a full project (`<folder>/project.json`) with the GreenLight Video
Editor's own animation presets: the same converter the GreenLight Motion connector's build_video uses in Claude and
ChatGPT. Write it as `<folder>/script.json`, run `script`, then `check` and `stills` and look at the contact sheet.
Change the SCRIPT and run `script` again (it rewrites project.json). For what a script can't say (3D, particles, motion
paths, masks, text animators by hand), go on from project.json with `apply` and the other references — and stop
running `script`, or it replaces those edits.

Pictures, video and music: put the files in `<folder>/assets/` and name them `asset:<file name>`; an https link
works too (it has to stay reachable). SVG you write: `{ "type": "image", "svg": "<svg …>…</svg>" }`.

## The scene script

**Before the script, a direction.** Presets make a video move; they don't give it an idea. Decide in a few lines first,
and keep them next to the script:
- **The idea**: ONE picture from the subject's own world (its object, place or action: a coffee shop's steam and cup rim,
  a budgeting app's receipt printing line by line, a running app's track the scenes run along), carried through every scene.
- **The palette**: background, text, one accent, plus only the colours that carry meaning (good / bad, before / after).
  Light or dark on purpose.
- **The type**: a big headline against a small support line; aligned left or centred on purpose, not by default.
- **Each scene**: what it SHOWS besides its words, built from shapes, lines, `svg` you write, keyframes and the camera.
The same line centred on a gradient in every scene reads as a template. Judge the stills against the direction, not
only for mistakes.
What a script can't say (a custom GLSL shader on a shape or the background, words dipping under a surface with a track
matte, masks, particles, 3D) goes on from `project.json`: SKILL.md, "Beyond the script".

```json
{
  "title": "Bean There — opening day",
  "format": "16:9",
  "style": { "background": "linear-gradient(160deg, #2b1a12, #0e0806)", "colors": { "text": "#f6efe7", "accent": "#d9a066", "muted": "#b8a594" } },
  "scenes": [
    { "name": "Hook", "duration": 2.6, "camera": "push-in",
      "elements": [
        { "type": "text", "text": "Bean There", "role": "headline", "textAnimation": "glide-text" },
        { "type": "line", "at": [-180, 92], "to": [180, 92], "start": 0.7 },
        { "type": "text", "text": "Coffee worth the detour", "role": "subhead", "at": [0, 150], "start": 0.9, "enter": "glide-soft-entry", "direction": "up" } ] },
    { "name": "Offer", "duration": 2.4, "transition": "Camera Whip", "camera": "drift-left",
      "elements": [
        { "type": "pill", "w": 560, "h": 116, "color": "accent", "start": 0.15 },
        { "type": "text", "text": "Opening day: 2 for 1", "role": "body", "color": "#1b120d", "start": 0.3, "enter": "pop-overshoot" } ] },
    { "name": "Close", "duration": 2.4, "transition": "Gradient Glow Stack", "background": { "shader": "silk", "look": "sunset" },
      "camera": { "move": "cm-quiet-push", "dof": { "focus": "street", "aperture": 50 } },
      "elements": [
        { "type": "circle", "w": 420, "color": "#fff3e0", "opacity": 0.3, "at": [330, -60], "z": -700 },
        { "id": "street", "type": "text", "text": "12 Elm Street", "role": "headline", "textAnimation": "word-swing" },
        { "type": "text", "text": "OPEN 7 – 7", "role": "label", "at": [0, 130], "start": 0.8, "letterSpacing": 6 } ] }
  ]
}
```

- **format** 16:9 · 9:16 · 1:1 · 4:5 (16:9 = 1920×1080, 9:16 = 1080×1920, 1:1 = 1080×1080, 4:5 = 1080×1350). Sizes and positions are in those pixels.
- **style**: `background`, `colors` { text, accent, muted }, `font`: a Google Fonts family (the page loads it from Google Fonts while online) or any font whose file you put in assets/ named after it (`Manrope.ttf`, .otf, .woff, .woff2: used offline).
- **at**: `center` `top` `bottom` `left` `right` `top-left` … or `[x, y]` px from the centre (+y is down). Keep text inside the middle 80 %.
- **text**: `role` headline | subhead | body | label sets size and weight (override with `size`, `weight`); `color` text | accent | muted | #hex |
  a CSS gradient; `width` (px, wraps), `align`, `uppercase`, `letterSpacing`, `lineHeight`. A headline gets `glide-text` unless you set `textAnimation`.
  The text box is CENTRED on `at`: without `width` it is as wide as its words but stays inside the frame (off-centre text wraps
  sooner); for a left-aligned column give `width` and `"align": "left"` and put `at` at the column's centre.
- **rect · pill · circle**: `w`, `h`, `color` (or a CSS gradient), `radius`, `border` {width, color}, `shadow`: true. They enter with `pop-overshoot` unless you set `enter` (`"none"`: no entrance, it is simply there).
- **line**: from `at` to `to`, `width`, drawn on (`draw`: false to skip).
- **ring**: a circle drawn as a stroke from the top, clockwise (a timer, a status or focus ring): `w` (diameter), `width` (stroke),
  `color`, `sweep` (degrees, 360 = full), drawn on (`draw`: false to skip), `drain`: true empties it again by the element's
  end (a countdown) or `[start, end]` (s into the element) empties it then, `ghost` (0–100: a faint full track under it).
- **image · video**: `src` (a file in the folder's assets/ as `asset:<name>`, or an https link) or, for an image, `svg` (SVG markup you write); `w` or `h`
  (px; the other follows the file's shape) or `fit` cover | contain
  (default: a video covers the frame, a picture sits at 70 % of contain), `rotate` (deg). A video also takes
  `startAt` (s into the file) and `volume` (0–100, default muted). No entrance unless you set `enter`.
- **html**: an HTML page as a layer — an interface (a product screen, an app window, a dashboard, a chat, a code editor) or a shot
  only code draws. The page: `html` (the whole document, written here: `"<!doctype html><html>…</html>"`, up to 512 KB) or `src`
  (a page file in the folder's assets/ as `asset:<page>.html`); `page`: its own size [width, height] in px (the frame's without
  it), which the layer fits into the frame; `w` or `h` (px) or `fit` cover | contain; `startAt` (s into the page), `rotate`.
  The engine draws the page itself, frame by frame on the video's clock: nothing is recorded first. It needs Chrome 157 or
  newer (`doctor` says). The page's CSS animations, `requestAnimationFrame`, timers, `performance.now()` and videos follow the video's time. Its own files go beside it (`<img src="img/logo.png">`), or name any file of the folder as `asset:<name>`.
  A transparent background lets the layers behind show; keep the words a person will change (titles, captions, a price) as
  text elements over the page, not in it. No entrance unless you set `enter`.
- **Keyframes on any element** — your own motion: `"keyframes": { "x": [[0, -400], [0.8, 0, "Smooth Glide"]], "scale": [[0, 0.9], [2, 1.05]] }`
  — tracks x, y (px offsets from `at`), scale, rotate (deg), opacity (0–1); each key [seconds into the element, value, easing of the
  segment after it — Smooth Glide, AE Smooth, Expo Out, Power, Punch, Apple Out, Back Out, Elastic, Linear …]. They replace an entrance's keys on the same track;
  one key holds that value for the whole element.
- **Every element**: `start` / `end` (s within its scene; default: staggered 0.12 s, to the scene's end), `enter` / `exit` (keyframe presets, `direction` up | down | left | right
  for directional ones), `effects`: [{ "id", "params"? }], `id`, `label` (its name in the page's options), `opacity` (0–1),
  `z` (px of depth, + toward the viewer, default 0: a real camera's dolly, orbit and depth of field separate layers by it), `locked`: true
  (the scene's camera doesn't move it: a logo, a caption). Keyframes also take a `z` track.
- **Scene**: `duration` (s), `transition` into it (default Cross Fade, 0.6 s; `transitionDuration`), `transitionOptions` (the
  transition's own settings, e.g. Circular Wipe's `point` { x, y } (% of the frame from its top-left: 50, 50 is the centre) and `feather`; every option: `npx greenlight-motion schema transitions`.
  A transition's vivid colours, such as Circular Wipe's beam, take the accent unless you set them; over a light backdrop Circular
  Wipe's glowing beam is off, since it flares there, unless you set `beam`), `camera` (below; default push-in),
  `background` (overrides style).
  **A transition overlaps the scenes on both sides**, so the video lasts the scenes' durations added up MINUS every
  transition: five 3 s scenes with the default 0.6 s transitions run 15 − 4 × 0.6 = 12.6 s. To hit a length, add the
  transitions back to the scenes (`script` prints the total).
- **Sound**: the script adds none and the engine has no sounds of its own. A film's sounds and music are files, chosen in the
  order the design rules give (references/video-design.md, Sound): what the user gave or named, then their own library or
  files, then generated with a tool they have or found in an open source. Music goes in `music` (below); a sound effect is an
  audio clip at the second of its event, added after the script with `apply` (`events` gives the seconds).
- **camera** — a quick move of the whole scene: none | push-in | pull-out | drift-left | drift-right | drift-up. Or a REAL camera that films the scene's elements in 3D (the
  Video Editor's own camera layer; the scene's backdrop stays put, so its edge never shows). One of:
  - `{ "move": id }` — a camera move from the catalogue (or just `"camera": "cm-quiet-push"`), spread over the scene;
  - `{ "rig": id }` or `{ "rig": { "preset"?: id, "type"?, …fields } }` — an orbit, crane, push-in, truck, spiral, handheld or follow move
    (`"camera": "heroOrbit"` works too). A `follow` rig rides elements: `"targets": [element ids]`. Layers are flat: keep an orbit within about
    ±70° of the front (heroOrbit, slowReveal) or they turn edge-on and read mirrored;
  - `{ "zooms": [{ "start", "end", "at"?, "zoom"? }], "feel"? }` — zoom in on spots and back out, like a screen recording's Smart Zoom: `at` as for
    elements (the spot to frame, clamped so the view stays inside the frame), `zoom` 1.05–4 (default the feel's, about 1.45), each zoom at least
    0.4 s and none overlapping; `feel` studio | calm | precise | lively | follow (the spring). Put a screen recording in as a video element (or the
    scene's video background) and zoom on what it shows;
  - `{ "keyframes": { zoom | x | y | roll | dolly | tiltX | tiltY | focusZ: [[seconds, value, easing?], …] } }` — your own move: zoom (×, 1 = none),
    x / y (px the camera pans right / down), roll / tilt (deg), dolly (px toward the scene: it changes perspective, so layers at different `z` part).
    With a `move` they replace its track; a rig drives x, y, roll, dolly and tilt itself and zooms drive zoom, x and y, so key only the others there.
  - plus `"dof": { "focus": element id | "focusZ": px, "aperture"?: 40, "blur"?: 100 }` (or `true`) — depth of field: what sits at another `z` blurs;
    the focus stays on its subject while the camera dollies or rides a rig. `focusZ` keys are a rack focus (measured from where the camera starts).
  - `start` / `end` (s in the scene; default the whole scene; outside them the camera rests). Keys and zooms count seconds into the camera.
- **background**: a colour, a CSS gradient, { "shader": id, "look"? } — shaders: silk, glowblobs, waves, plasma, mesh, fire, spacetravel, glitters, blueplanet, auroraridge, emberpool, neonvignette, electricvignette, spectrumdrift, emberfacet, silkdrift, eclipseprism, glassreeds, staticfringe, ripplefold, nightaurora, pixelbeams, petalgrid, amberblinds, icehalo, windowhaze (looks: references/video-backgrounds.md) — or { "image": src } / { "video": src } (covers the frame; b-roll behind the scene).
- **music** (script level): `"music": { "src": file, "volume": 80, "fadeIn": 0.3, "fadeOut": 1.2, "startAt": 0 }` — one track under the video.
  The file must exist when you run `script` (it reads its length): write a sound you make in code before the first run.

## A 3D Scene: `world`

3D in a video is GreenLight Dash's own 3D Scene: give the script a `world` (the same `rig.scene` JSON its editor
stores), drawn in Draft as it plays and path traced in Final — for any shot that is 3D (a product, a device, a room, a logo
or title in depth, abstract forms, a camera moving through space), not only a product on a table. You model what the shot
needs yourself; keep it SIMPLE: objects built from ops (box, cylinder, lathe, extrude, bevel…), materials (glass, liquids,
metals, wood and other procedural patterns), up to a few lights, a bundled HDR environment, `scene.camera` or a ready move.
A device the brief names that is among the bundled presets (`iphone_pro_max`, `iphone_air`, `double_iphone`, `ipad`,
`ipad_mini`, `macbook_pro`, `macbook_air`, `imac`) may be taken ready-made: after `script`, add a `model3d` layer with
`"url": "model-preset:<id>"` to project.json (references/video-world3d.md, a device from the preset table: its own channel
and `model3dConfig`, with an example; its screen picture in `screen`, `{ "url": "asset:<file>", "fitMode": "cover" }`); it
stands in the Scene's world, lit by it, path traced in Final, its screen artwork kept. Model a device yourself, or use
another model, only when the brief asks. A `model3d` layer or a camera layer on a flat comp with no `world` is not how 3D is done. No files of your own in the
Scene's `world` here (big scenes with meshes and textures belong in GreenLight Dash).
`scenes` become optional: 2D titles over the world, see-through unless a scene sets its own `background`.

```json
{ "format": "16:9", "title": "Éclat", "world": {
    "duration": 4,
    "camera": { "move": "orbit", "amount": 30 },
    "render": { "mode": "draft" },
    "look": { "contrast": 1.15, "bloom": 0.06, "vignette": 0.2 },
    "scene": {
      "camera": { "at": [0, 0.2, 0.75], "target": [0, 0.1, 0], "fov": 30 },
      "env": { "intensity": 0.3, "opaque": true },
      "lights": [{ "id": "key", "type": "area", "at": [-0.5, 0.6, 0.5], "target": [0, 0.1, 0], "width": 0.5, "height": 0.5, "intensity": 6 },
                 { "id": "rim", "type": "spot", "at": [0.3, 0.5, -0.4], "target": [0, 0.1, 0], "angle": 25, "penumbra": 0.4, "intensity": 4 }],
      "materials": {
        "wood": { "procedural": { "pattern": "wood", "planks": 3 }, "uvScale": [2, 2] },
        "glass": { "roughness": 0.02, "transmission": 1, "ior": 1.5, "priority": 1 },
        "perfume": { "transmission": 1, "ior": 1.36, "attenuationColor": "#e8a440", "attenuationDistance": 0.3, "priority": 2 },
        "gold": { "metal": "gold", "roughness": 0.2 } },
      "objects": [
        { "id": "table", "material": "wood", "at": [0, -0.02, 0], "graph": [{ "op": "box", "size": [1.2, 0.04, 0.7], "bevel": 0.004 }, { "op": "uvBox" }] },
        { "id": "bottle", "material": "glass", "at": [0, 0.001, 0], "graph": [{ "op": "cylinder", "radiusTop": 0.045, "radiusBottom": 0.045, "height": 0.16, "bevel": 0.006 }, { "op": "transform", "at": [0, 0.08, 0] }] },
        { "id": "liquid", "material": "perfume", "at": [0, 0.001, 0], "graph": [{ "op": "cylinder", "radiusTop": 0.0395, "radiusBottom": 0.0395, "height": 0.11 }, { "op": "transform", "at": [0, 0.06, 0] }] },
        { "id": "cap", "material": "gold", "at": [0, 0.177, 0], "graph": [{ "op": "cylinder", "radiusTop": 0.02, "radiusBottom": 0.02, "height": 0.03, "bevel": 0.003 }] } ] } },
  "scenes": [{ "duration": 4, "elements": [{ "type": "text", "text": "ÉCLAT", "role": "headline", "at": "top" }] }] }
```

- `world` takes `scene`, `render`, `look`, `exposure`, `camera`, `duration`. `scene`, `render` and `look` are GreenLight Dash's
  `rig.scene`, `rig.render` and `rig.look`: every field, op and material is in references/video-world3d.md and references/world3d-schema.json. Units are metres (model things at their
  real size: the perfume bottle above is 16 cm tall), Y is up.
- **What `world` sets for you:** no Rig lights and no Rig backdrop (it writes `renderer: "world"`, `lights: []`,
  `cyclorama: none`): the light is `scene.lights` plus `scene.env` (a bundled HDRI, `studio_small_03_1k` unless
  `env.hdri` names another `/hdr/<name>.hdr` of the ten presets), and a floor, table or studio sweep is an object you model
  (a box; a sweep is an `extrude` of an L-shaped profile with a rounded corner).
- **Checked strictly.** A field the 3D engine would ignore (a typo, a three.js name such as `emissive`, `position`, `color` on a
  liquid) fails the build with its path and the right name (`world.scene.materials.glass.transmision: … did you mean
  `transmission`?`), as does an unknown op or parameter, a material or parent that is not there, a broken lathe profile.
  An op that fails only when the geometry is built (a boolean that cannot be made) shows in look_at_video's critique:
  "the scene did not build: …".
- **The camera:** `scene.camera` (`at`, `target`, `fov`, `keys` for your own moves) or a ready move in `world.camera`: one
  smooth in-out move over the whole clip, always looking at `target`. `push-in` starts at `scene.camera.at` and ends
  `amount` of the way to the target (0–0.9 [0.25]); `pull-out` is the same backwards. `orbit` turns around the target by
  `amount` degrees in all [40]; `rise` goes up by `amount` of the distance [0.25]; `slide-left` / `slide-right` move
  sideways by `amount` of the distance [0.25], the target with them. These three are centred on `scene.camera.at`: half
  the amount before it, half after, so frame the middle of the clip there. A scene's own 2D `camera` defaults to `none`
  over a world (titles hold still).
- **Camera moves, worked.** Frame the subject with room to spare: the critique samples the whole move (every key and evenly
  between them) and names an object the move takes out of the frame, and when.
  - *Orbit* around a product: `"camera": { "move": "orbit", "amount": 40 }` with `"scene": { "camera": { "at": [0, 0.22, 0.8],
    "target": [0, 0.09, 0], "fov": 30 } }`. The middle of the clip is shot from `at`; the turn goes 20° to each side, so a
    framing that is tight from the front clips a wide object at the ends: step back (a longer `at`) or turn less.
  - *Push-in* to a detail: `"camera": { "move": "push-in", "amount": 0.35 }` starts at `scene.camera.at` and ends 35 % of the
    way to `target`, so the last frame is the tightest: aim `target` at the detail (the label, the cap). Your own keys do the
    same with a lens change: `"keys": { "at": [{ "t": 0, "v": [0, 0.2, 1], "ease": "inOut" }, { "t": 4, "v": [0, 0.14, 0.5] }],
    "fov": [{ "t": 0, "v": 30, "ease": "inOut" }, { "t": 4, "v": 24 }] }`.
  - *Rack focus* (depth of field): `"camera": { "at": [0.25, 0.12, 0.55], "target": [0, 0.08, 0], "fov": 28, "fStop": 2,
    "keys": { "focus": [{ "t": 0.8, "v": 0.42, "ease": "inOut" }, { "t": 2.2, "v": 0.78 }] } }`: sharp on what stands 0.42 m from
    the camera, then on what stands 0.78 m away. `focus` is a distance in metres along the view (for an object at p:
    (p − at)·(target − at) / |target − at|); `"@id"` holds the focus on an object, but keys from one `"@id"` to another jump
    instead of racking, so key distances. A low `fStop` (1.4–2.8) makes the blur strong; leave `fStop` out for all sharp.
    Draft blurs roughly; judge it in Final. Focus keys go with a ready move too: a push-in with `"focus": "@bottle"` stays sharp on the bottle.
- **Titles over it:** `scenes` are 2D layers over the world, see-through unless a scene sets its own `background`
  (`style.background` does not cover the world). Keep a title clear of the objects: a 2D layer stands in the world's depth
  (about 2.2 m from the camera at 1080 px high), so an object nearer the camera that overlaps it hides its letters. Put it where
  the frame is calm and has the contrast its colour needs: a light title on a light set vanishes. The critique below gives each
  object's span in % of the frame and checks every 2D layer: how much of it the objects hide, its contrast against what is
  under it, whether it leaves the frame or the title-safe area (5 % in from each edge), and texts that overlap. The video is as long as the scenes and the world
  lasts all of it (`world.duration` counts only for a world with no scenes).
- **Draft and Final.** `render.mode` `"draft"` (default) plays live; `"final"` path traces every frame (`spp` 16–64 here):
  seconds per frame, so render Final only for the finished version, and short. Judge glass and liquids in Final: Draft shows no
  liquid inside glass and no refraction, and only a rough depth of field.
- **No length limit here** (the chat caps a Final MP4 at 10 s at 64 samples; locally the only limit is your GPU's time).
- **The 3D plugin.** The 3D engine is a separate package, `greenlight-motion-3d`: `script`, `build`, `check`, `stills`
  and `render` get it by themselves the first time a folder has a `world` (into the user's cache, once per version);
  `npx greenlight-motion add-3d` gets it now, `doctor` says which version is there. Offline, point
  `GREENLIGHT_MOTION_3D` at an unpacked copy or its .tgz.
- **Its critique.** look_at_video on a build with a world adds a critique of the middle frame: what the shot shows object by
  object (its share of the frame, where it stands, what hides it, what is out of the camera), where each light stands against
  the subject, the picture's numbers, and hints naming the field to change. Fix what it names, then build again.

## What makes it look made, not generated

references/video-design.md — the same design rules GreenLight Dash's agents and the chat connector use. Read it before
the first version and check every version against it.

## Catalogues

**Text animations** (`textAnimation`; ★ = preferred): ★ `glide-text` Glide Text · `glide-continuous` Glide Continuous · `smart-overshoot` Smart Overshoot · `glide-soft-stop` Glide Soft Stop · ★ `ember-type` Ember Type · `molten-edge` Molten Edge · `focus-type` Focus Type · `tumble-type` Tumble Type · `flap-down` Flap Down · `drop-swell` Drop Swell · `rain-type` Rain Type · `counter-sweep` Counter Sweep · `sunset-shrink` Sunset Shrink · `boomerang` Boomerang · ★ `swing-pop` Swing Pop · ★ `word-swing` Word Swing · ★ `letter-vortex` Letter Vortex · `center-burst` Center Burst · ★ `pendulum` Pendulum · `spin-pop` Spin Pop · `domino` Domino · `flip-pop` Flip Pop · `card-turn` Card Turn · `slam-zoom` Slam Zoom · `orbit` Orbit · ★ `fan-deal` Fan Deal · ★ `whip` Whip · `rubber-letters` Rubber Letters · `pop-letters` Pop Letters · `drop-swing` Drop Swing · `coin-spin` Coin Spin · `converge` Converge · `roll-in` Roll In · `door-swing` Door Swing · `title-push-3d` Title Push 3D · `perspective-type` Perspective Type · `rack-focus` Rack Focus · `stand-up` Stand Up · `strata` Strata · `spotlight` Spotlight · `ripple` Ripple · `pill-type` Pill Type · `card-type` Card Type · `word-bars` Word Bars · `line-stack` Word Stack · `marker-type` Marker Type · `card-erase` Card Erase · `colour-sweep` Colour Sweep · `glow-pass` Glow Pass · `wave-pass` Wave Pass · `pop-through` Pop Through · `shine` Shine · ★ `marker` Marker · ★ `outline-pass` Outline Pass · ★ `neon-flow` Neon Flow · `rainbow` Rainbow · `gradient-flow` Gradient Flow · `jitter` Jitter · `float` Float · `flicker` Flicker · `breathe` Breathing Wave · `shimmer` Shimmer · `decode` Decode · `binary` Binary Decode · `alphabet-roll` Alphabet Roll · ★ `glitch` Glitch · `classic-fade-up` Fade Up · `classic-fade-down` Fade Down · `classic-rise-mask` Rise (Mask) · `classic-blur-in` Blur In · `classic-slide-in` Slide In · `classic-side-mask` Side Mask · `classic-tilt-drop` Tilt Drop · `classic-flip-up` Flip Up · `classic-typewriter` Typewriter · `classic-wave-rise` Wave Rise · `classic-bounce-letters` Bounce Letters · `classic-materialize` Materialize · `classic-neon-runner` Neon Runner · `classic-ink-highlight` Ink Highlight · `classic-flash-type` Flash Type · `classic-karaoke-sweep` Karaoke Sweep · `classic-chase-loop` Chase Loop · `classic-sung-words` Sung Words · `classic-marker-lines` Marker Words · `classic-pill-grow` Pill Grow · `classic-lower-third` Lower Third · `classic-drop-bar` Drop Bar · `classic-outline-tag` Outline Tag · `classic-prompt-field` Prompt Field · `classic-random-pop` Random Pop · `classic-chaos-letters` Chaos Letters · `classic-random-rise` Random Rise · `classic-ransom-note` Ransom Note · `classic-editorial-typer` Editorial Typer

**Entrances** (`enter`): `slide` Slide · direction · `glide` Glide (in and out) · direction · `glide-stop` Glide Stop (in and out) · direction · `glide-floaty` Glide Floaty (in and out) · direction · `glide-endless` Glide Endless (in and out) · direction · `glide-diagonal` Glide Diagonal (in and out) · direction · `glide-arc` Glide Arc (in and out) · direction · `glide-close-pass` Glide Close Pass (in and out) · direction · `glide-fade-drift` Glide Fade Drift (in and out) · direction · `glide-bank` Glide Bank (in and out) · direction · `glide-swing-3d` Glide Swing 3D (in and out) · direction · `glide-linger` Glide Linger (in and out) · direction · `glide-soft-entry` Glide Soft Entry (in and out) · direction · `glide-blur` Glide Blur (in and out) · direction · `glide-spin-through` Glide Spin Through (in and out) · direction · `glide-depth-pass` Glide Depth Pass (in and out) · direction · `glide-tilt` Glide Tilt (in and out) · direction · `zoom-in` Zoom In · `mockup-close-up` Mockup Close-Up · `mockup-orbit-left` Orbit Left · `deck-drift` Deck Drift · `hero-punch` Hero Punch · `dark-spotlight` Dark Spotlight · `phone-app-swipe` Phone Swipe Reveal · `phone-app-punch` Phone App Punch In · `phone-app-tilt-drift` Phone Tilt Drift · `phone-app-cta-hold` CTA Hold Focus · `button-press` Button Press · `button-tap-flash` Tap Flash · `pop-overshoot` Pop Overshoot · `spring-in` Spring In · `rubber-wobble` Rubber Wobble · `tap-nudge` Tap Nudge · `whip-swing` Whip Swing · `flick-drop` Flick Drop · `jelly-shake` Jelly Shake · `heartbeat` Heartbeat · `impact-punch` Impact Punch · `pendulum-swing` Pendulum Swing · `loose-wiggle` Loose Wiggle · `shiver` Shiver · `float` Float · `flicker-in` Flicker In · `earthquake` Earthquake · `tumble-drop` Tumble Drop · `rubber-band` Rubber Band · `spring-twist` Spring Twist · `slingshot` Slingshot · `pendulum-in` Pendulum In · `smooth-overshoot-rise` Smooth Overshoot Rise · `spin-in` Spin In · `twist-in` Twist In · `roll-in` Roll In · `tilt-settle` Tilt Settle · `wind-up-spin` Wind-Up Spin

**Exits** (`exit`): `slide` Slide Out · `zoom-in` Zoom Out · `mockup-close-up` Mockup Close-Up · `mockup-orbit-left` Orbit Left · `deck-drift` Deck Drift · `hero-punch` Hero Punch · `dark-spotlight` Dark Spotlight · `phone-app-swipe` Phone Swipe Reveal · `phone-app-punch` Phone App Punch In · `phone-app-tilt-drift` Phone Tilt Drift · `phone-app-cta-hold` CTA Hold Focus · `button-press` Button Press · `button-tap-flash` Tap Flash · `pop-overshoot` Pop Out · `spring-in` Spring Out · `rubber-wobble` Rubber Wobble · `tap-nudge` Tap Nudge · `whip-swing` Whip Out · `flick-drop` Flick Up · `jelly-shake` Jelly Shake · `heartbeat` Heartbeat · `impact-punch` Impact Out · `pendulum-swing` Pendulum Swing · `loose-wiggle` Loose Wiggle Out · `shiver` Shiver Out · `float` Float Away · `flicker-in` Flicker Out · `earthquake` Earthquake Out · `tumble-drop` Tumble Up · `rubber-band` Rubber Band Out · `spring-twist` Spring Untwist · `slingshot` Slingshot Out · `pendulum-in` Pendulum Out · `smooth-overshoot-rise` Smooth Overshoot Drop · `spin-in` Spin Out · `twist-in` Twist Out · `roll-in` Roll Out · `tilt-settle` Tilt Away · `wind-up-spin` Wind-Up Spin Out

**Transitions** (★ = preferred): None · ★ Cross Fade · Push · Parallax · Wipe · Zoom In · Zoom Out · ★ Advanced Zoom · ★ Advanced Movement · 3D Carousel · Louver Flip · ★ Circular Wipe · ★ Pixel Blocks · ★ Camera Whip · ★ Zoom Ruler · ★ Gradient Glow Stack · ★ Gradient Map · Scale Swap · Side by Side · Dip to Black · Radial Wipe

**Camera moves** (`camera.move`; spread over the camera's length): `cm-quiet-push` Quiet Push (Cinematic) · `cm-swoop-dive` Swoop Dive (Cinematic) · `cm-corkscrew` Corkscrew (Cinematic) · `cm-fast-orbit` Fast Orbit (Cinematic) · `cm-lateral-glide` Lateral Glide (Cinematic) · `cm-parallax-arc` Parallax Arc (Cinematic) · `cm-arc-closeup` Arc Close-Up (Cinematic) · `cm-push-in` Push In (Cinematic) · `cm-orbit-hold` Orbit Hold (Cinematic) · `cm-rise-and-reveal` Rise & Reveal (Cinematic) · `cm-slingshot` Slingshot (Editorial) · `cm-step-zoom` Step Zoom (Editorial) · `cm-handheld-breath` Handheld Breath (Editorial) · `cm-soft-land` Soft Land (Editorial) · `cm-documentary-follow` Documentary Follow (Editorial) · `cm-weave-run` Weave Run (Energy) · `cm-s-curve-drift` S-Curve Drift (Energy) · `cm-macro-sweep` Macro Sweep (Energy) · `cm-punch-through` Punch Through (Energy) · `cm-whip` Whip (Energy) · `cm-orbit-pulse` Orbit Pulse (Loops) · `cm-float` Float (Loops) · `cm-figure-eight` Figure Eight (Loops) · `cm-rack-to-near` Rack to Near (Focus) · `cm-rack-to-far` Rack to Far (Focus) · `cm-focus-chase` Focus Chase (Focus) · `cm-macro-bloom` Macro Bloom (Focus) · `cm-grand-reveal` Grand Reveal (Cinematic)

**Camera rigs** (`camera.rig`; the fields you can override: type orbit | dolly | crane | pushIn | truck | spiral | handheld | follow, aim center | path, radius 100–20000, height -8000–8000, startAngle -360–360, sweep -720–720, rise -8000–8000, distance -20000–20000, turns 0.25–8, tilt -80–80, roll -180–180, amplitude 0–2000, frequency 0–40): `heroOrbit` Hero Orbit (orbit) · `slowReveal` Slow Reveal (orbit) · `turntable` Turntable (orbit) · `craneDown` Crane Down (crane) · `riseReveal` Rise & Reveal (crane) · `pushIn` Push In (pushIn) · `pullBack` Pull Back (dolly) · `truckLeft` Truck Left (truck) · `productSpiral` Product Spiral (spiral) · `handheldDrift` Handheld Drift (handheld) · `droneFollow` Drone Follow (follow) · `chaseCam` Chase Cam (follow)

**Zoom feels** (`camera.feel`): `studio` Studio · `calm` Calm · `precise` Precise · `lively` Lively · `follow` Follow. Full camera layers (paths, Smart Zoom on a recording's clicks, the drawn cursor): references/video-camera.md.

**Overlay effects** (`effects`): `glow`, ★ `bloom`, `auraBlur`, `gradientBeam`, ★ `gradientSweep`, `gradientGlow`, `fractalNoise`, ★ `rgbSplit`, `glitch`, `scanlines`, `flashBlink`, `vhs`, `fisheye`, `opticsCompensation`, `vignette`, ★ `echo`, `timeshift`, `radialBlur`, ★ `radialFastBlur`, `sharpen`, `mirror`, `waveWarp`, `warpStyles`, `shockwave`, `waveLines`, `waveRipple`, `fill`, `shapeRulers`, `copyColor`, `curves`, `turbulentDisplace`, `alphaChoker`, `gooey`, `extract`, ★ `colorama`, `posterize`, ★ `halftone`, ★ `fastCameraWiggle`, ★ `lightRays`, `lightSweep`, `longShadow`, `outlineBands`, `kaleidoscope`, `crtMatrix`, `pixelate`, `vectorFieldWarp`, `pixelStretch`, `neonGlow`, `edgeDetect`, `doubleExposure`, ★ `filmStock`, `fastBlur`, `gridLines`, `strip`, `ascii`, `objectDither`, `objectIsolines`, `objectWindow`, `objectSlitScan`, `objectCurtain`, `objectGrid`, `objectContour`, `objectNodes`, `objectLinks`, `objectFacets`, `objectMeasure`

**Layer effects** (`effects`): `mockupFrame`, ★ `runningGlow`, `depthMap`, `depth3d`, `depthScan`, `depthKey`, `fresnelRim`, ★ `motionBlur`, `posterizeTime`, ★ `motionTrail`, `autoFill`, ★ `repetile`, `regionDistort`, `bend`, `cornerPin`, `meshWarp`, `bezierWarp`, `rig`, ★ `droste`, `pryzm`, ★ `glass`, `chromaKey`, `layerMask`

Effect params: references/video-effects.md.

