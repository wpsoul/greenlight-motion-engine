> **A 3D Scene in GreenLight Motion:** a scene script's `world.scene` is `rig.scene` below, and `world.render`, `world.look`
> and `world.exposure` are `rig.render`, `rig.look` and `rig.exposure`. The script writes `"renderer": "world"`, `"lights": []` and
> `"cyclorama": { "shape": "none" }` itself, so the Rig adds no lights and no backdrop: light comes from `scene.lights` and
> `scene.env` (the bundled HDRIs, default `studio_small_03_1k`), and a floor or a studio sweep is an object you model. A
> `world` is in metres (real sizes). The renderer ignores a field it does not know, but the script checks every field
> first and fails the build with the right name. Your own files (models, textures, splats) are not part of a `world` here,
> and titles are the script's scenes. Ignore the `/api/...` routes and the Rig's settings below. To check the picture, use
> look_at_video's critique in a chat, or `npx greenlight-motion check` locally.

# 3D Scene: field notes

What real Scenes teach: the way an agent naturally builds something, what that looks like on screen, and the fields and
values that do it right. Read it before you build a Scene; the format itself is [video-world3d.md](video-world3d.md) and the
simulations' is sim.md (GreenLight Dash only). Each note is **Wrong** (the natural way and what it looks like), **Right** (fields and
values) and **Why** (the mechanism, with its measured number).

## Motion

### A resting hero that turns "a few degrees a second"
- **Wrong:** the slow constant turn of [the pattern](video-world3d.md#the-pattern) (5) at 5–10°/s on a hero resting between moves:
  on screen the hero reads as stopped.
- **Right:** 20–30°/s (0.7–1° a frame at 30 fps), in the same direction as the spins that land and leave, so the landing slows
  into it and the leaving spin speeds up from it; centre it on the hold, so the face is square to the camera mid-hold (24°/s
  over a 45-frame hold sweeps ±18°). A float of ±3 mm on an 80-frame cycle, faded with the hero's scale, adds life.
- **Why:** at 24°/s the landing's speed falls 93 → 52 → 33 → 24°/s and holds there (read off the render): no stop, no jump.

### Parts of a group that slide against it
- **Wrong:** a part placed once, or carried by a second group that copies only the group's scale keys: when the group turns, the
  part stays where it was and slides against the rest.
- **Right:** `"parent": "<group id>"`, `at` in the group's own space, and in its own `keys` only its own motion (`scale` keys = its
  size ratio: the parent's scale multiplies). Whatever sits in it rides the same way: a cup as the group's child, the cup's sim
  with `transform: { "parent": "<cup group>", "rest": <s> }` (sim.md (GreenLight Dash only), time and place).
- **Why:** a child takes its parent's `at`, `rot` and `scale` every frame; placed this way, parts land within 0.04 mm of a
  Blender rig's world positions over the whole move. See [the pattern](video-world3d.md#the-pattern) (6).

### Every channel keyed on its own
- **Wrong:** scale, spread, camera, spin and the next hero each keyed on their own times and eases: each move works on its own,
  starts and stops at its own moment, and the whole reads jerky.
- **Right:** one clock per move and each channel its own remap of it ([clocks and drives](video-world3d.md#clocks-and-drives),
  [the pattern](video-world3d.md#the-pattern) 1–3).
- **Why:** channels that read one clock peak on the same frames (0 frames apart) while each keeps its own curve.

### A camera that travels through several beats
- **Wrong:** `scene.camera` keyed pose to pose with in-out eases: it stops on every key. Or a `drive` on `at` / `target` with no
  key on that field: the field is then the drive's sum alone, so the camera starts at the world's origin (the still's critique
  reports every object "behind the frame").
- **Right:** one base key per driven field and one drive term per move, each move its own linear clock and its own app ease, the
  next move starting 0.3–0.5 s before the last one lands:
  `"keys": { "at": [{ "t": 0, "v": [0, 0.012, 0.5] }] }, "drive": { "at": [{ "clock": "dive", "map": [[0, [0, 0, 0], "aeSmooth"], [1, [-0.58, -0.17, -1.23]]] }, { "clock": "push", "map": [[0, [0, 0, 0], "aeSmooth"], [1, [0, 0, -0.1]]] }] }`.
  Split a dive into a `z` term and a later, slower `x`/`y` term to fly straight through a gap first and curve after it; a turn
  round a set is an expression term written to be 0 at its start (`"[rr * sin(a) - r0s, h - h0, rr * cos(a) - r0c]"`, `r0s`,
  `h0`, `r0c` its start values as numbers).
- **Why:** terms add, so where two moves overlap their speeds add and the path never stops between them: six overlapping moves
  over 13.5 s gave no frame-to-frame stop or jump in the render's motion outside the ones keyed on purpose.

### A burst that wipes into the next set
- **Wrong:** pieces flung out of the object's plane and toward the lens while the camera dives through: in a 9:16 frame they
  leave within 3 frames and the next set appears small in an empty frame; a piece whose path crosses the camera's fails the
  frame guard (`FRAME_EMPTY`: "transparent while the world drew 23 objects in view").
- **Right:** pieces that fly on ahead along the camera's way (0.15–1.05 m toward the next set, 0.05–0.22 m outward, `appleOut`
  over 0.8–1.2 s, 8–15 mm coins from a 16 mm one), the camera accelerating after them (`aeSmooth`) so it overtakes them through
  the wipe; each piece checked ≥ 6 cm from the camera's position over the whole burst, then a slow linear drift and `visible` off.
- **Why:** the camera passes the pieces over 0.4 s instead of 0.1 s, so they cross the frame large and blurred through the cut,
  and no frame needs a redraw.

## Materials and liquids

### A strong clear coat on deep colours
- **Wrong:** `coat` 0.75, `coatRoughness` 0.05, `roughness` 0.24 on deep saturated object colours for "gloss": the coat's white
  reflection lies over the colour, and a navy reads lavender-grey.
- **Right:** coloured plastics at `roughness` 0.4, `coat` 0.3–0.35, `coatRoughness` 0.18–0.2, `specular` 0.6; keep strong coats
  for chrome balls and lacquered furniture.
- **Why:** on a navy (`base` #232d74) the soft coat takes saturation from 118 to 142 (of 255) and R/G from 96/103 down to 70/78.

### A dark drink that reads as a solid mass
- **Wrong:** a sim liquid made dark by lowering `transmission` (coffee at 0.85) or by a short `absorb` picked by eye: the splash
  reads as chocolate, a dense brown mass, instead of a liquid the light passes through.
- **Right:** `"transmission": 1` and the colour only from `base` over `absorb`, tuned on a Final still:
  `"material": { "base": "#8a4a22", "transmission": 1, "ior": 1.34, "roughness": 0.02, "absorb": 0.032 }`
  (a 15 cm coffee splash: thin sheets amber, the thick body dark, light showing through). Halve `absorb` for a denser drink.
- **Why:** every point of `transmission` under 1 is a cloudy share, a lit skin of `base` over the liquid (0.85 = a 15 % brown
  skin); a liquid's own colour is its absorption over the distance the light travels in it
  (sim.md (GreenLight Dash only)).

### Glass pieces that fly through the lens's blur
- **Wrong:** small glass objects (a burst of glass coins, shards, drops) with `dispersion` 0.3 for "rainbow edges", at `spp` 24, flying
  through the out-of-focus zone near the lens with motion blur on: coloured speckle on every piece, and the denoiser smears what is
  left into milky blotches on the moving ones.
- **Right:** no `dispersion` on glass that is not a gem close-up (`iridescence` 0.6–0.9 gives the coloured rim without it) and `spp` 64
  for the shots where glass is out of focus and moving, motion blur left on (it is traced in the same pass):
  `"render": { "mode": "final", "spp": 64 }`, `"seaGlass": { "transmission": 1, "roughness": 0.02, "iridescence": 0.85, … }`.
- **Why:** dispersion traces one wavelength a path, so its colour needs 512–2048 samples ([glass](video-world3d.md#glass-and-liquids)): on an
  out-of-focus glass coin at 64 samples it alone is a third of the colour grain (chroma 1.97 → 1.27). The noise falls as 1/√spp (the
  difference from a 256-sample frame: 8.05, 6.15, 3.85 at 32, 64, 128); motion blur spreads a pixel's samples over the shutter as well
  as the lens, so 24 left the moving pieces to the denoiser's smear. The same burst at 64 samples without dispersion, blur on: its
  pieces keep their edges and lose the speckle.

### A bottle on a polished plinth
- **Wrong:** one glossy material shared by the plinth and other objects (`"stone"` on the plinth and on a slab beside it), or the bottle
  hovering over the plinth's top: Draft reads the stone black under the bottle and the liquid, seen against it, dark at its foot.
- **Right:** the plinth's own material (`"plinthStone": { "base": "#1c1a1b", "roughness": 0.18, "coat": 0.6, "coatRoughness": 0.05 }`)
  and the product's foot on its top (`at` y = the top's height, within 5 mm), its top flat and at least 0.01 m2.
- **Why:** Draft mirrors the set on such a top only for a material of its own with something standing on it
  ([glass](video-world3d.md#glass-and-liquids)); then the perfume's plinth reads 107 of 255 in Draft where Final reads 114 (16 without it).

## Light and look

### Blender's view exposure
- **Wrong:** Blender's exposure *e* written as `"exposure": 2^e`: the picture is 0.43 stop over, and emissive screens and coat
  reflections read washed out.
- **Right:** `"exposure": 2^e / 1.35` (Blender's −0.2 is 0.645) with the same `look.view`
  ([`exposure`](video-world3d.md#turn-it-on-and-write-a-scene): 1/1.35 is Blender's 0; a `.blend` import writes it).
- **Why:** with it an emissive screen lands within 1–2 levels of Blender's own frame (108 against 108–109).

### Window shadows from a sun's gobo in a moving shot
- **Wrong:** a sun with `"gobo": { "pattern": "window" }` and a camera that turns or pulls back toward the sun's side of the set:
  the gobo is real geometry standing out of frame toward the sun, and the camera comes to see it: a black band with the window's
  bright opening along the frame's edge (the left 8 % of a desk shot's last second).
- **Right:** keep the camera looking away from the sun's side for the whole move (check the move's last frame), or leave the gobo
  out of that shot (`lights: [{ "type": "sun", … }]` with no `gobo`); the same set from the other side keeps its gobo.
- **Why:** the gobo is placed for the light, not for the camera; without it the same last frame showed the wall and the plant only.

### Lights carried over from Blender
- **Wrong:** raising lights by eye when lit surfaces come out darker than a Blender frame.
- **Right:** carry them as they are: an area light's `power` in Blender's watts, a sun's `intensity` as its Strength, `env.intensity`
  as the World strength and `env.rotation` as its mapping's turn; look for what differs in the scene itself (the room, what stands
  between the light and the surface, the meshes).
- **Why:** on a matte plate Final matches Cycles within 0.5 % for each (an area light 10 W at 2 m: 0.1875 against 0.1869; the
  studio HDRI at 0.5 and a sun at 6.5: 1.00).

### A shot that must read as a small camera's footage
- **Wrong:** a fixed exposure, `look.grain` and a straight lens opened to fov 90+: driving from a sun patch under a table the
  picture drops to near black (mean 52 of 255 against 138 in the sun), the grain is as strong in the sun as in the shade, and the
  frame's edges stretch.
- **Right:** `"camera": { "device": "actionCam", "fov": 72 }` (or its parts: `"autoExposure": { "lag": 0.6, "strength": 0.8,
  "metering": "average", "min": -3, "max": 4 }`, `"noise": 1`, `"projection": "stereographic"`), the camera moving at a robot's
  or a walker's pace (0.3–1.5 m/s) through light and shade; the windows' glare is the device's `look.bloom` 0.06 over 1.2.
- **Why:** on a 7 s drive under a table the exposure opens 1.65 stops after the shade, two thirds of it in 0.6 s (dark for a moment,
  then readable: mean grey 105 of 255 against 54 for a fixed exposure) and stops down twice as fast coming out (a short blow-out);
  the noise follows that gain and the dark: about 4–4.7 levels of colour noise in the shadows against 1.2–1.3 in sunlit highlights.
  A still gets exactly the exposure the same frame has inside the whole render.

## Text and screens in the world

### A title that turns with its hero
- **Wrong:** a title riding a spinning or tumbling hero (`worldParent`), or given the hero's own yaw: the word turns, leans and
  rolls with it.
- **Right:** its own 3D Text layer, square to the Scene camera at rest: `rotateY` = asin(−f.x), `rotateX` = asin(f.y / cos rotateY)
  in degrees, `rotateZ` 0, where f is the camera's unit forward ([placing 3D Text](video-world3d.md#placing-3d-text-in-the-world)).
  A camera looking 4° down: `"rotateX": -4, "rotateY": 0`. Its arrive and leave animators may turn letters; the rest pose stays
  square. `worldParent` stays right under an object that only moves and scales.
- **Why:** 3D Text stands in the world's axes, not the camera's; squared this way the baseline's slope is 0.1° (4.2° at a −20° yaw).

### White titles over pale rooms
- **Wrong:** white or near-white 3D letters over pastel walls: 1.3–1.6:1 against the wall behind them; the word is lost.
- **Right:** letters in the section's own colour with the hero's kind of material, `"text3d": { "sceneMaterial": "<id>" }` with
  `metalness` 0.55, `roughness` 0.22, `coat` 0.8, `coatRoughness` 0.05, darkened until they read about 3:1 (green #2d8965, blue
  #3e68a8, pink #a04670 on peach, lavender and pink walls: 2.7, 3.3, 3.9:1).
- **Why:** pastel walls sit near L\* 80–85, so the letters must be dark to read; glossy letters keep their colour where they catch
  light.

### A print on a card or a screen that reads mirrored or shows its back
- **Wrong:** a `plane` op's own uv for a card's printed face (it reads mirrored from the front); one print seen through a
  transmissive card from behind (reversed); a screen that turns with its group (it shows its back).
- **Right:** after the plane is turned to face +z, `{ "op": "uvPlanar", "axis": "z", "fit": true, "scale": [1, -1], "offset": [0, 1] }`;
  a second print for the back (`"scale": [-1, -1], "offset": [1, 1]`, turned to face −z) with an opaque core between; a screen's
  own `rot` keys the inverse of its group's turn, so its world turn stays its rest turn and it faces the camera.
- **Why:** a turned plane keeps the uv of its own x and y, which reads mirrored for a viewer in front; `uvPlanar` lays the picture
  as the face is seen.

### A picture on a ready-made device's display
- **Wrong:** the picture on a `model-preset:` device through `model3dConfig.screens` naming its display (`"material": "17ProMax_Screen"`):
  the display stays black, with a Scene and without.
- **Right:** the device's own `model3dConfig.screen`, `{ "url": "/media/….png", "fitMode": "cover" }`, on the preset layer standing in
  the Scene ([video-3d.md](video-3d.md)): the picture reads upright on every preset, glows in Draft and Final and lights the set in Final.
- **Why:** `screens` dresses only the mesh it names; `iphone_pro_max` has an opaque cover glass 0.1 mm over its display, which only
  `screen` fades (to 0.15 opacity).

### A ready-made device that comes out the wrong size
- **Wrong:** `"fit": "unit"` with `fitValue` 1000, taking the device's file for metres: `macbook_pro` stood about 1.5 m wide on a
  1.4 m desk. `"fit": "width"` on a tablet laid flat with `rotateX: -90`: it came out 1.39 times too big.
- **Right:** size it by a real measure in % of the frame: a laptop by its width, `"fit": "width"`, `fitValue` = width × 1000 / W × 100
  (a 31.3 cm MacBook Pro on a 1920-wide frame: 16.28); a device that stands portrait (`ipad`, a phone) by its long side,
  `"fit": "height"`, `fitValue` = long side × 1000 / H × 100 (a 24.8 cm iPad on a 1080-high frame: 22.94), then turned flat.
- **Why:** the fit measures the file's rest pose: the tablet's file stands portrait, so its width is the short side.

### A page on a screen that is blank after the cut
- **Wrong:** the html item that feeds a Scene's `screen` (a material's `layer`, a device's `screen.layer`) starting at its Scene's
  cut: the page loads on the shot's first frames, and the screen shows dark or empty for 8–12 frames (0.3–0.4 s) of the render.
- **Right:** start the page's item 1 s before the cut (`freeStart` = cut − 1, 1 s longer) and let the page count its own time from
  there (`draw(t − 1)`); pages of consecutive shots then overlap, so they alternate between two hidden source channels.
- **Why:** the page is loaded and running when its Scene starts: in the render the card showed its page from the cut's first frame,
  where it was black for 9 frames.

### A screen page whose text sets in `system-ui`
- **Wrong:** a page on a Scene's `screen` (or an html clip) whose CSS gives controls `font: … system-ui, -apple-system, sans-serif`
  (buttons, chips, a caption textarea): at home it sets in the Mac's UI face, but rendered on the render farm's Linux pods the same
  text comes out in a monospace face.
- **Right:** name a face the page loads itself (an `@font-face` of the page) for every element, controls included:
  `textarea, input, button, .chip { font-family: 'Inter', -apple-system, sans-serif !important; }`.
- **Why:** `system-ui` is whatever the machine calls its UI font, and the pods resolve it to a mono face; a loaded face travels with
  the page (its font files are shipped with it) and sets the same at home and on the farm.

### Titles that vanish behind the Scene
- **Wrong:** a project whose bottom channels are all camera-locked (a hidden page that feeds a `screen`, then the Scene layer,
  then camera-locked titles): the titles count as the background plate and every object in front of them covers them (still
  `critique.layers2d`: `underScene: true`, `hidden: 1`).
- **Right:** an ordinary (not camera-locked) channel at the bottom of the stack, such as the music's, and the feeding page's
  channel not camera-locked; every camera-locked title above the Scene's channel then draws over the Scene.
- **Why:** a camera-locked channel with only camera-locked channels under it (the Scene's own does not count) is laid under the
  Scene; with the music's channel at the bottom a brand name under a glass coin went from 100 % hidden to whole.

### A bank of phones that each show a page or a picture
- **Wrong:** a `model3d` preset layer for every phone: a reel of 15 phones is 15 timeline layers keyed in pixels, and they cannot
  ride a spinning Scene object; a picture on a `box` or a `plane` of its own reads upside down or mirrored.
- **Right:** the body an `extrude` of `{ "rect": [0.0715, 0.1496], "radius": 0.0108 }` (`depth` 0.0078, `bevel` 0.0016), a black glass
  slab inset 1.3 mm, and the screen a 0.1 mm `extrude` inset 3.1 mm with `{ "op": "uvPlanar", "axis": "z", "fit": true, "scale": [1, -1], "offset": [0, 1] }`,
  its material `{ "base": "#000000", "screen": { "layer": "<html item id>", "resolution": [660, 1434] }, "coat": 1, "coatRoughness": 0.025 }`
  (a page, live) or `{ "emission": "#ffffff", "maps": { "emission": "<png>" }, "emissionStrength": 0.95, "coat": 0.45 }` (a picture).
  Many phones: the same graphs then `{ "op": "transform", "at": [0, 0, R] }` and `{ "op": "radialArray", "count": 15, "axis": "x" }`
  (a reel), one screen object per picture with `count` 3 and its own `rot` offset by whole steps.
- **Why:** the screen's uv is laid as the face is seen, so page and pictures read upright on every copy; a 15-phone reel is 7
  objects instead of 45, and a page's counter runs live on the glass in Draft and Final.

## Simulations

### A splash that must hang in the air
- **Wrong:** holding a splash by keying `gravity` off and a strong `drag`: once let go, the liquid falls into a thin sheet in
  mid-air.
- **Right:** `"clip": { "freeze": { "at": <clip s> }, "fadeIn": 0.12, "fadeOut": 0.2 }` (held to the clip's end, or `until`), and
  `transform.parent` to ride its container (time and place (GreenLight Dash only)).
- **Why:** a frozen sim does not step: its frame is the same on play, scrub and export.

### Slow motion of a splash
- **Wrong:** slowing the physics to get slow motion (weaker gravity, fewer steps): it changes the motion's shape.
- **Right:** `"clip": { "speed": 0.15 }` (0.22 s of eruption over 1.47 s of film) with `substeps` a multiple of m, the smallest
  count of fine frames per film frame with speed × m whole: 60 at 0.15 (m 20, 3 substeps each).
- **Why:** the sim steps m finer frames of its own per film frame; with `substeps` that m does not divide, it takes a count where
  speed × m is not whole. Done right, the rise grows every frame (10 → 159 px over 32 frames), no frame repeated.

### Bubbles that pop and leave water
- **Wrong:** a sphere keyed to scale 0 (nothing is left), or a shell of MPM water held round by the water's `tension` (on a film one
  cell thick the grid's surface force is noise: 8 N/m crumples it before the pop, 2 holds nothing); or the freed water pulled together
  by two dense fields splatted every substep (two 25 MB fields cost 165 ms of a 358 ms frame).
- **Right:** each bubble an MPM water film three particles thick (`cell` 0.005), born by its own `emit` with an `init` on its sphere
  (a burst, then a keyed `rate` as it swells); one `snippet` (`phase: "velocity"`, `writes` with `"mat"`) is the gas: a damped spring
  to the radius (`k` 4000, `damp` 20), each gas pushing every film inside it outward, motion along the film damped (12), its thickness
  evened along `gridGrad(p.P)` (0.06); the pop a front `1.6 (t - tp)` of arc from one point: behind it a film inside a living neighbour
  becomes the neighbour's, the rest goes free with 1.6 m/s along the film as `p.mat = MAT_drops;` (gravity, and `gridGrad(p.P) * 0.15`).
  `mpm.materials`: `film` { `kind` "water", `tension` 0.5, `cohesion` 150, `friction` 0.6, `sticky` 0.12 } and `drops` (the same with
  `tension` 2); draw `of` ["film", "drops"], `smooth` 3, `iso` 0.3, `relax` 8; `mpm.memory` 480; no dense field. A Final video of it:
  `scene.caustics: false`.
- **Why:** the films keep their small tension while the drops have their own (waters of different tension on one grid, sim.md (GreenLight Dash only));
  400 ms after a 6 cm bubble pops its drops of 100+ particles are twice as round (0.41 against 0.24) and the film before the pop as smooth.
  The grid's own mass replaces the fields' 50 MB, not their time (the sim frame at 6 s: 390 ms against
  415 with the fields; 200 without any grid read). The globe's caustic does not show on a dark stage, and with it each motion-blurred Final frame
  is 16 traces (222 s against 13 s a frame). `scene.warnings` says when `mpm.memory` runs out ("Raise mpm.memory to N").

### A petal or a spathe of an imported flower that gives under a falling product
- **Wrong:** the cloth given as its own triangles inline (`"mesh": { "positions", "indices" }`) with a plain material of its colour:
  it has no uvs, so the flower's veins (its maps) are gone and it reads as a grey rubber sheet.
- **Right:** `{ "op": "cloth", "mesh": "<the imported part's id>", "pin": [<the base's vertex indices>], "bend": 3, "density": 0.35 }`
  with its draw naming no `material` (`{ "set", "piece", "look": "mesh" }`); the part leaves the picture, the cloth stands in its place.
- **Why:** a cloth made from an object keeps that object's corners, uvs and material, and holds the mesh's own folds at rest
  (sim.md (GreenLight Dash only)): untouched it reads as the part it was made from (veins, folds, white), and only what pushes it moves it.

## Rendering and checking

### A long Final in one render
- **Wrong:** one render of the whole film: the GPU is held for most of an hour, and a failure near the end loses all of it.
- **Right:** `render-onserver-job` in ranges of about 24 frames, joined as a [film rendered in parts](video-motion-notes.md#a-film-rendered-in-parts)
  is. 1080 × 1920 at `spp` 64 with `denoiseLook` "clean" takes 9.4 s of rendering a frame, 10.5 s with each range's start-up, on
  an M2 Max: 3.5–5 minutes a range, a 316-frame film 55 minutes.
- **Why:** a range that fails costs only itself, a later change re-renders only its ranges, and the user's app gets the GPU back
  between ranges; the joins show no seam (the change from frame to frame at each join equals Draft's at the same frames).

### A change that shows only in one window of a Scene
- **Wrong:** `reuse` after changing one sim's material: the Scene layer counts as changed, and its whole span renders again.
- **Right:** render only the ranges that show the change, at the first render's range boundaries, and join again
  ([a film rendered in parts](video-motion-notes.md#a-film-rendered-in-parts)).
- **Why:** reuse (GreenLight Dash only) renders a changed layer's whole time, and the Scene is one layer;
  ranges outside the change stay identical (0.00 levels).

### A card that dissolves in over the last Scene shot
- **Wrong:** the Scene item, its `model3d` layers and the html items its screens read all ending on the frame where an opaque 2D
  card (an end card's field) starts fading in: a frame with no Scene layer draws no world, so the card fades in over the
  project's `background`, not over the shot.
- **Right:** run those items on past that frame until the card is opaque (the card's start + its fade + 2–3 frames: a longer
  `trimEnd` and clip `duration`, the camera keys as they were), and end them there.
- **Why:** the frames under the half-transparent card then show the shot dissolving away. Running the Scene under the whole card
  only adds traces nobody sees: on a 919-frame film whose card fades in over 0.45 s and stays 3.2 s, the farm plans 545 Final
  frames with the Scene ending once the card is opaque and 623 with it running to the end.

### What Draft does not tell you
- **Wrong:** judging a Scene's brightness or its liquids on Draft stills.
- **Right:** judge them on Final stills (`render-still` with `"mode": "final"`, `critique` with `compare: true` for Final over
  Draft, [check your work](video-world3d.md#check-your-work)).
- **Why:** Draft's light itself is Final's: on a matte plate an area light, a sun and a studio environment each land within 1 %
  of Final and Cycles. What Draft has no rays for is not: a furnished desk's light bounced round the room reads about 13 % brighter
  in Draft over the whole frame and a pastel room's 14–18 %, while a studio product shot reads 3 % darker. Draft builds a liquid
  from the picture behind it, so it differs most where that picture misleads: water resting on a dark glossy floor reads about 45
  levels lighter than Final, a cloudy liquid (`transmission` 0.85) about 25 levels darker, and a clear splash stays a little
  lighter at its foot.

### Flicker in a Final video of a moving shot
- **Wrong:** raising `spp` from 16 to 32 (twice the render time) to calm a Final video that seems to flicker, or judging its
  frame-to-frame change against another renderer's video of the same shot without matching their light first.
- **Right:** `spp` 16–24 with the defaults (each video frame steadied against the one before after the denoiser; `softReuse` unset);
  judge flicker on a part of the frame nothing moves through (a wall the camera only slides over), or on what two renders of the shot
  with different samples do not share; against another renderer, match the brightness first ([Blender's view exposure](#blenders-view-exposure)).
- **Why:** on a moving shot almost all of the frame-to-frame change is the picture's own motion: on a 1080 × 1920 film shot 99.5 %
  of it, and 32 samples instead of 16 lowered the flicker number 1.5 %. A darker, more contrasty light moves more levels for the same
  motion: a film whose light was darker than Cycles' read 4.47 against Cycles' 3.91, and 3.86 once mapped onto Cycles' brightness.

### Carrying the soft light between video frames
- **Wrong:** `"softReuse": true` on a set with screens, prints, glossy gadgets or glowing parts (a desk interior, a product on a floor):
  every frame then draws new samples and the light that is not carried (reflections, coats, glow) boils, with no cleaner frames once
  the video is H.264.
- **Right:** leave `softReuse` unset for video. Set it `true` only for a shot whose light is nearly all matte (walls, paper, wood, at
  least 9/10 of the light) with much of the frame lens-blurred, delivered at a high bitrate (`"format": "mov-prores4444"`).
- **Why:** measured through the export at 16 samples against the default: a glossy desk interior flickers 18 % more with it, an
  emissive night desk 25 % more and a product on a floor 8 % more, with the same error in the MP4; a matte, lens-blurred film shot
  gets 7–19 % cleaner frames as ProRes (0.5–2 % in the MP4) at equal flicker.

### A still or a render at another shape than the project
- **Wrong:** `render-still` (or a render) with a `width` / `height` of another aspect ratio than `videoSize` to get a quick small
  check of a Scene that a Camera layer steers: the composition is resized to that frame and the Camera layer's px pan and zoom mean
  another shot there; a square 4096 product shot asked at 1280 x 720 filmed no object at all and came back plain black.
- **Right:** a check at the project's own shape (`width` / `height` in its ratio, or left out), or change `videoSize` itself and
  look at a still before rendering; read `render-check` on the finished file (rendering.md (GreenLight Dash only)).
- **Why:** a size of the same ratio renders a scaled copy (px keep their meaning); another ratio reflows the composition
  (output size (GreenLight Dash only)). An empty shot is not
  an error: a map's sky lets the layers below through, so it shows the project's background.

### Reading a turn off the render
- **Wrong:** reading an object's turn from its silhouette's width: near facing the camera the width hardly changes (±18° moves it
  5 %), and past a quarter turn a frame it aliases.
- **Right:** two small glowing spheres as children of its turning node, one in front of its face and one behind, both above it
  (`at` [0, 0.13, 0.06] and [0, 0.16, −0.06] in its own space, a `sphere` op of `radius` 0.007, materials
  `{ "base": "#000000", "emission": "#ff0000", "emissionStrength": 3 }` and the same in green); render the object alone over a
  plain background, find both spheres in each frame, and solve the yaw from their horizontal offset through the camera's projection.
- **Why:** a sphere 9 cm off the axis at 1.4 m moves about 6 px a degree: the turn reads to about 1.5°/s frame to frame.

## Adding a note

- In the app this page is read-only: write a general lesson to your user's engine notes (`PUT /api/agent/engine-notes/world3d`,
  or the file at the `path` it gives, engine notes (GreenLight Dash only)), and what
  holds for one board only to that board's memory.
- When: a project showed a wrong way, a right way, or a value worth keeping.
- Shape: a heading naming the situation, then **Wrong**, **Right** (fields, values, a JSON fragment) and **Why** (the mechanism and
  its measured number), 3–8 lines, under the group it belongs to.
- Write for an agent that writes JSON and calls endpoints, in the present tense: no UI words, versions, dates, history or project
  names, and link to [video-world3d.md](video-world3d.md) or sim.md (GreenLight Dash only) instead of repeating them.
- Only what the engine does now, checked on a render or in the code.
- Remove a note when the engine no longer behaves that way.
