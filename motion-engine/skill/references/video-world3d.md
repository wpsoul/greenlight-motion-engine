> **A 3D Scene in GreenLight Motion:** a scene script's `world.scene` is `rig.scene` below, and `world.render`, `world.look`
> and `world.exposure` are `rig.render`, `rig.look` and `rig.exposure`. The script writes `"renderer": "world"`, `"lights": []` and
> `"cyclorama": { "shape": "none" }` itself, so the Rig adds no lights and no backdrop: light comes from `scene.lights` and
> `scene.env` (the bundled HDRIs, default `studio_small_03_1k`), and a floor or a studio sweep is an object you model. A
> `world` is in metres (real sizes). The renderer ignores a field it does not know, but the script checks every field
> first and fails the build with the right name. Your own files (models, textures, splats) are not part of a `world` here,
> and titles are the script's scenes. Ignore the `/api/...` routes and the Rig's settings below. To check the picture, use
> look_at_video's critique in a chat, or `npx greenlight-motion check` locally.

# GreenLight Dash — build 3D in the Scene, with no Blender

> New to the 3D Scene? Start with world3d-quickstart.md (GreenLight Dash only): the smallest good Scene, the ten fields that matter, where to read next.
> Read [video-projects.md](video-projects.md) for the versioned-write contract and [video-3d.md](video-3d.md) for model layers and the Rig. Load only what the task needs.
> Before you build, read the field notes: [video-world3d-notes.md](video-world3d-notes.md), what real films taught (wrong ways and the right one, with values), and in the app your user's own: `GET /api/agent/engine-notes/world3d` (engine notes (GreenLight Dash only)).

The Scene layer (the `rig` clip) can hold a whole world that an agent wrote as JSON: geometry from a node graph, materials, lights, simulations and keyframes. It renders together with the 3D layers on the timeline, in **Draft 3D** while the user works and path traced in **Final 3D**. Nothing here needs Blender or any other install, but **a 3D Scene needs the WebGPU engine**: in an editor on WebGL, or on a computer with no WebGPU, the preview and the Scene panel show a notice instead of the Scene (the panel's "Switch to WebGPU" sets the engine), and 2D layers keep drawing. Renders and stills of a project with a Scene always run on WebGPU, automatically, whatever the app's engine or the request's `renderer`.

## Contents

- [The defaults: never and prefer](#the-defaults-never-and-prefer)
- [Turn it on and write a scene](#turn-it-on-and-write-a-scene)
- [Filming the Scene with the Camera layer](#filming-the-scene-with-the-camera-layer): [units and axes](#units-and-axes), [free move](#a-free-move-a-push-in-with-a-slight-orbit-and-a-focus-pull), [path move](#a-path-move-a-crane-and-orbit-round-an-object), [rig](#a-rig-a-built-in-camera-rig-round-an-object-and-a-saved-preset), [zoom](#a-zoom-onto-a-scene-object-and-back), [from scene.camera](#from-scenecamera-to-the-camera-layer), [check the framing](#check-the-framing-without-a-final)
- [The scene format](#the-scene-format): [materials](#materials), [glass and liquids](#glass-and-liquids), [glowing surfaces](#glowing-surfaces), [procedural materials](#procedural-materials), [texture graphs](#texture-graphs-smart-materials-with-wear-and-dirt-graph), [animated materials](#animated-materials-edge-glow-live-noise-beam-sweep-graph-presets), [`translucency` and `subsurface`](#light-through-a-sheet-light-into-a-body-translucency-and-subsurface), [`iridescence`, `metal`, `anisotropy`, `roundEdges`](#thin-film-real-metals-brushed-metal-round-edges-iridescence-metal-anisotropy-roundedges), [car paint, dust, toon](#car-paint-dust-and-toon-flakes-coatbump-dust-toon), [the material library](#the-material-library-preset), [`displacement`](#real-relief-from-a-height-displacement), [`reveal`](#a-surface-that-comes-and-goes-reveal), [objects and graphs](#objects-and-graphs-blender-outside-houdini-inside)
- [Motion design: one clock per move](#motion-design-one-clock-per-move): [clocks and drives](#clocks-and-drives), [expressions](#expressions-a-drivers-scripted-expression), [ƒx on keys](#the-editors-ƒx-on-scene-keys-fx), [follow path](#follow-path-path), [riding an object](#riding-a-scene-object-parent-and-worldparent), [the pattern](#the-pattern), [a worked example](#a-worked-example)
- [Ops](#ops): [solids](#solids), [sheets and points](#sheets-and-points), [modifiers](#modifiers-one-input-the-node-before-unless-in-says-otherwise), [several inputs](#several-inputs-set-in), [points to copies](#points-to-copies), [harder shapes](#harder-shapes), [rooms and furniture](#rooms-and-furniture), [escape hatch](#escape-hatch)
- [Lights in the scene](#lights-in-the-scene): [kelvin, watts, lumens, IES](#light-in-a-lighting-designers-units-kelvin-power-lumens-ies), [highlight placement](#put-the-highlight-where-you-want-it-highlight), [studio presets](#studio-presets-type-studio), [light and shadow linking](#which-light-reaches-what-tags-light-linking-and-shadow-linking), [light mix and passes](#light-mix-and-light-passes-looklightmix-renderlightpasses), [ray visibility and holdouts](#what-each-kind-of-ray-sees-visibility-holdout), [render passes and masks](#render-passes-and-masks-renderpasses-lookpassmix-world-mattes)
- [Shadows in Draft](#shadows-in-draft)
- [Fog and haze](#fog-and-haze)
- [Smoke and fire](#smoke-and-fire)
- [Cloth and soft bodies](#cloth-and-soft-bodies)
- [Water, sand, snow and goo](#water-sand-snow-and-goo)
- [Rigid bodies](#rigid-bodies)
- [Pictures in the world (`inWorld`)](#pictures-in-the-world-inworld)
- [Motion blur](#motion-blur)

## The defaults: never and prefer

GreenLight Dash's defaults for every 3D Scene, as [video-design.md](video-design.md#the-defaults-never-and-prefer) has them for video. A
user's own request wins over a default. Check each one on a still before you report a scene done.

### Never

- **Objects passing through each other, unless it is meant.** After every build and every re-arrangement render a still with
  `"inspect": true` and read `scene.inspect.overlaps` ([Check your work](#check-your-work)): each pair with
  `intersecting: true` is either meant (a stem in its vase, liquid in its bottle, a cap on its neck, a label on glass, a thing
  resting on its support) or a fault: a flower inside a bottle, a prop sunk into a desk, a strap through a body. Fix a fault by
  moving, turning or bending the part, never by scaling the hero. `inspect` reads the rest pose: for keyed or simulated
  objects also look at stills of the times where they come closest.
- **The camera inside the Scene.** Leave `scene.camera` out and film the Scene with the timeline's Camera layer
  ([video-camera.md](video-camera.md)): its keys, eases, paths, depth of field, Camera Rig and presets are what the user can see and
  edit in the editor; a `scene.camera` has no rows there. Use every mode the Camera layer has, whichever fits the move: a
  free move (keys on its position, turns and zoom), a path move
  ([Camera Motion Paths](video-camera.md#camera-motion-paths-camerapath--campatht)), a rig
  ([Camera Rig](video-camera.md#camera-rig--a-parametric-camera-move)) and zoom
  ([the camera's Zoom mode](video-camera.md#smart-zoom--the-cameras-zoom-mode)). Use `scene.camera` only for something the Camera layer
  cannot do, and say which thing in your report.
- **Easing that breaks the video rules.** Motion in 3D follows the same rules as video
  ([video-design.md](video-design.md#the-defaults-never-and-prefer)): no key on every frame, only the app's easing presets, no jerks.

## Turn it on and write a scene

Everything lives on the `rig` clip's item, in `rig`. Write it through the ordinary project PATCH (live project, versioned write).

```json
"rig": {
  "renderer": "world",
  "cyclorama": { "shape": "none" },
  "lights": [],
  "env": { "source": "preset", "preset": "studio_small_03_1k", "intensity": 0.6 },
  "exposure": 1,
  "look": { "contrast": 1.3, "saturation": 1.1, "bloom": 0.1, "glare": 0, "halation": 0.05, "vignette": 0.15, "grain": 0.1 },
  "render": { "mode": "final", "spp": 64, "bounces": 8, "denoise": true },
  "scene": {
    "lights": [{ "id": "key", "type": "sun", "dir": [0.4, 1, 0.3], "intensity": 3, "size": 2 }],
    "materials": { "clay": { "base": "#c9a184", "roughness": 0.6 } },
    "objects": [{ "id": "ball", "material": "clay", "graph": [{ "op": "sphere", "radius": 0.2 }] }]
  }
}
```

- Every Rig is a 3D Scene drawn by this world renderer, on the WebGPU engine only, unless `rig.renderer` is `"classic"`. Write `"renderer": "world"` anyway: only with it does `"lights": []` mean no Rig lights instead of coming back as the default key, fill and rim (below).
- The project's Camera layer films it ([below](#filming-the-scene-with-the-camera-layer)): a camera clip at 1.6 m, 0.4 m up, looking at the ball is
  `{ "cameraMoveMode": "free", "cameraLookAt": "@ball", "camY": -37.04, "camDolly": 566 }` on a 1920 × 1080 project.
- `scene` holds `objects`, `materials`, `lights`, `camera`, `env`, `sims`, `layers2d`, `volumes` (baked only) and `physics`, in the format below. `rig.env.tint` colours the environment's light, in Draft and Final. The Rig's own backdrop, lights and environment join it, and every `model3d` layer on the timeline stands in the same world, so objects shadow each other.
- The letters of a 3D Text layer (`text3d`, [below](#3d-text-in-the-world)), and those of a flat text layer with `textInWorld` ([below](#flat-text-in-the-world)). Shadows in the world come only from what it holds (scene objects, the backdrop, model layers, 3D Text, flat letters with `castShadow`, sims), so a flat layer's `shadowPlate.castShadow` casts none on it.
- A model the world draws takes no `opacity` or `blendMode`: bring it in or out with scale, position or rotation keys.
- A `scene.camera` takes the shot from the Camera layer: it films from its own `at` and `target`, keys included, and the Camera layer's move
  only steers it from there. Write one only for what the Camera layer cannot do ([the list](#what-only-scenecamera-does)). A `.blend` import
  puts its shot on the Camera layer (blender.md (GreenLight Dash only)).
- `render` is what every render and still of the project uses: `mode` `"draft"` (the default) or `"final"`. Final traces every frame, so expect seconds per frame. Like Draft, it renders on WebGPU, which every render and still of a project with a Scene uses automatically (rendering.md (GreenLight Dash only)).
- Final's quality fields, with their defaults and ranges: `spp` [64, 1–4096], `bounces` [8, 1–32], `transparentBounces` [5, 0–32] (layers of glass a ray passes through), `glossy` [0.5, 0–1] (blurs reflections of reflections so they don't sparkle; glass whose caustic the caustic pass draws stays sharp), `clamp` [0 = off, up to 1000] (caps one sample's brightness against fireflies), `denoise` [true], `denoiseLook` ["clean" (the default: the denoiser alone, smoothest, with its large network in every render), "natural" (a fifth of the traced picture, its fireflies out, mixed back over the denoised one, so some grain and surface detail stay: set it for that grain; a Scene that sets it keeps it) or "raw" (the samples the denoiser read, shown without it)], and `exposure` [1, 0.05–4], which scales Final's picture only, to match Draft or a Cycles frame (a `.blend` import sets it).
- `"lightPasses": true` keeps each light group's light apart in Final, so `look.lightMix` rebalances a finished trace without tracing
  again ([Light mix and light passes](#light-mix-and-light-passes-looklightmix-renderlightpasses)).
- Bounces by kind of surface, each under `bounces` and unset by default (then only `bounces` limits it): `diffuseBounces` [0–32] (off
  matte paint, plaster, wood, cloth), `specularBounces` [0–32] (off metal, a clear coat, a mirror, the reflection off glass) and
  `transmissionBounces` [0–32] (through glass and liquid, thin glass, translucent leaves and lampshades; `transparentBounces` is cut-out
  alpha, a different count) and `volumeBounces` [0–32] (scatters in a medium: the scene's [fog](#fog-and-haze) and a sim's smoke and
  fire). A path that runs out of one kind ends there, its last hit still lit directly: `diffuseBounces: 0` is
  direct light only on matte surfaces (no colour bleeding, darker corners), `specularBounces: 1` keeps a mirror's reflection but not
  the reflection of a reflection, `transmissionBounces: 2` lets a ray in and out of one solid glass (a thin wall, an open mesh or `thinWalled`, is one
  surface: one transmission), `volumeBounces: 0` lights fog and smoke by the light that reaches them and no further (single scattering:
  thinner, darker smoke; the fog's own `bounces` counts depth in the path instead, this counts the scatters themselves). They are for the look and for control (a darker, more graphic room; a mirror that shows no infinite
  regress; liquid in glass that needs many passes while the walls need few: `transmissionBounces: 12` with `diffuseBounces: 3`), not
  for speed: with the radiance cache a room's paths already end early, and `diffuseBounces: 1` saved about 5 % of a Final still there.
  Every bounce left out takes its light away, so a lower limit is a darker picture. Setting one builds the tracer's kernels once with
  the counts; a scene that sets none (or none below `bounces`) traces as before.
- Nested glass is counted apart: clear glass and water (roughness under 0.1) never spend `bounces` (they have a budget of their own,
  below), and where see-through bodies that do spend them nest or touch (frosted glass, rough ice: closed transmissive objects whose
  boxes overlap) and `transmissionBounces` is unset, a path's first 4 passes through a surface do not count against `bounces`. A path
  through a drink crosses two surfaces a body; at the default 8 its ice is clear, and a path that passes through nothing ends where it
  did. Set `transmissionBounces` to take the count back into your own hands.
- Through smooth glass and water (roughness under 0.1) the denoiser follows what lies behind them, as Cycles' denoising guides do: a
  drop on a petal, a glass of water or a lens keeps the picture it refracts sharp instead of being smoothed as one clear surface.
- `denoise: false` traces for no denoiser (another way of picking light samples, with less grain, and no carried light between video
  frames), so its picture is not the denoised one's samples. To see exactly what the denoiser starts from, keep `denoise: true` and set
  `denoiseLook: "raw"`: same trace, same samples, the denoiser still runs (same time), only the picture shown or rendered is its input.
  Natural, Clean and Raw are the same trace shown three ways; in the editor's preview a change between them shows at once.
- Final ends its light paths in a radiance cache of the room's light after their first bounce, in stills and video renders alike. In a room, `spp: 32` looks like 64 without it, in about half the time and with no extra flicker. In an open scene lit mostly by the sky it gains little, so halving the samples there is not free. `"radianceCache": false` in `render` turns it off.
- `exposure` (the Rig's, default 1) multiplies the light every view takes, in Draft and Final. `1/1.35` (0.741) is Blender's view at
  exposure 0, so Blender's view exposure *e* is `"exposure": 2^e / 1.35` here (−0.2 is 0.645, 0.5 is 1.048) with the same
  `look.view`; through AgX a `.blend` import also divides by its AgX match step (2^0.275) and the look's own step. A `.blend`
  import writes it, to `exposure` and to `render.exposure`.
- `look` and `exposure` are the film look, and changing them never rebuilds the world. A `look` field left out takes its default:
  `contrast` 1.25, `saturation` 1.3, `bloomThreshold` 1, and 0 for `bloom`, `glare`, `halation`, `vignette` and `grain`.
  `bloomThreshold` is read on the light as the picture is exposed (`exposure`, the camera's, Final's `render.exposure`), so a part as
  bright in Draft as in Final glows as much in both.
- `look.whiteBalance` is the camera's white balance in kelvin, as on a camera: the colour of the light it takes for white. Unset (or
  6500) changes nothing; 7000 to 8000 warms a room lit by an overcast sky (white walls with the faint warm cast interior photographers
  give them), 3200 to 4500 cools a room lit by lamps. A photographic interior also wants `contrast` 1.1 to 1.15 and `saturation` 1
  to 1.1 (the defaults are a film's).
- `look.localTone` (0 to 1, off by default) is local tone mapping, what an interior photographer's exposure blend does: a room lit
  through its window is five or six stops under the sky, and one exposure either blows the window, its frame and the wall round it out
  or leaves the room grey. With it the picture's large-scale brightness more than `localToneKnee` stops (default 1) over the scene's grey
  is brought down by that share, while everything smaller (texture, contact shadows, threads, the window's bars against the sky) keeps
  its contrast: expose for the room and the window holds. `localToneShadows` (0 to 1, default a third of `localTone`) lifts the large
  dark areas, `localToneContrast` (1 to 2, default 1) deepens the large-scale light under the knee (a room's fall-off from its window:
  its far corner darker, its ceiling darker toward the back), `localToneDetail` (default 1; 1.1 to 1.3 a photographer's clarity) scales
  the kept detail. Draft and Final alike; a look without it costs nothing. A daylit room: `{ "localTone": 0.6, "localToneKnee": 1.6,
  "localToneShadows": 0, "localToneContrast": 1.5, "localToneDetail": 1.1, "contrast": 1.35 }` with the exposure that puts the walls
  by the window near white, and the view out of the window (`env.view`) at its natural `intensity` 1. Past about 1.7 contrast or 1.2
  detail the strongest edges (a dark sofa against a white wall, leaves against the window) pick up thin halos.
- `look.view` picks the view transform, as Blender's View Transform: `"agx"` (the default film curve, with `contrast` and `saturation`),
  `"aces"` (ACES 1.3's RRT and sRGB output, by Stephen Hill's fit: more contrast, highlights rolling to white), `"neutral"` (Khronos
  PBR Neutral: colours exactly as authored up to near white, for product colours that must read true) or `"standard"` (plain sRGB,
  clipping). `contrast` and `saturation` shape AgX only; the scene's exposure means the same light in every view (Blender's exposure
  as `exposure`: above). Measured against Blender 5.1's own views of the same light: Neutral and Standard within 2 levels of
  255; ACES within 1.5 on greys and up to 11 on fully saturated primaries (the fit leaves out ACES's gamut corrections).
- `look.lut` grades the filmed picture with a look-up table: a `.cube` 3D LUT URL (`"/media/…/look.cube"`, from any grading tool),
  `{ "cube": "<the file's text>" }`, or a built-in grade: `"tealOrange"`, `"warmFade"`, `"bleach"`, `"cool"`, `"mono"` (`"identity"`
  changes nothing). It takes the picture after the view transform (display sRGB), as grading tools expect; `look.lutStrength` (0 to 1)
  mixes it. A file that does not parse leaves the picture ungraded and says why in `scene.warnings`.
- `look.aberration` (0 to 1) is a lens's lateral chromatic aberration: red and blue fringes that grow toward the corners (1 is about
  0.8 % of the half width at the corners). Draft and Final.
- `look.tone: "plate"` films the picture through sRGB alone instead of the film curve (AgX with `contrast` and `saturation`): for objects put into real footage, whose environment and floor were read off the footage the same way, so a grey the footage shows at half brightness comes back at half, and a sky reflected in chrome is as bright as the sky in the shot. Set it with `contrast: 1, saturation: 1`; the footage call (GreenLight Dash only) sets all three. With it, `look.soften` (px, 0–3) blurs the world's picture where it joins the layers below, coverage with it, to the footage's own softness, and `look.black` (0–0.15) lifts the world's surfaces' darks to the footage's black level (toward `look.blackTint`, [r, g, b] at unit brightness, default grey; a catcher's shadow is never lifted); 0 (the default) skips both. While `soften` is on, `look.grain` is laid on after that blur (so the blur does not take the footage's grain away again). `look.sharpen` (0–1) adds the world's own fine detail back as a camera's sharpening does, inside the objects only (never at their outline); `look.wrap` (0–1) wraps the light of the layers right under the Scene onto the objects' edges (a light wrap: a dark object on a bright table, a window behind it), only where those layers are full-frame, camera-locked footage at the bottom of the stack. The footage call measures and sets all of them; `env.keyDir` ([x, y, z], y up) names the direction the environment's key light comes from, which Draft's directional shadow follows.
- <a id="model-layers-in-the-world"></a>A `model3d` layer turns in the world as a scene object does, as 3D Text does: `rotateX` is `rot[0]`, `rotateY` is `rot[1]`, and `rotation` / `rotateZ` keeps its on-screen sense (clockwise as you face it, `rot[2]` negated). A model turned like an object at `rot: [rx, ry, rz]` takes `rotateX: rx, rotateY: ry, rotateZ: -rz`, keys included; `model3dConfig.baseRotation` reads the same way (its `x`, `y`, `z` as `rotateX`, `rotateY`, `rotateZ`). It keeps that turn while an effect takes it out of the world for its own pass, and in the editor's 3D view. A model in a channel locked to the camera, inside a sequence, or with no Rig / `renderer: "classic"` turns in the editor's own sense (Rotate X / Y the opposite of `rot`).
- Every `model3d` layer keeps its `screen` and `screens` artwork, its GLB clips and its pose ([video-3d.md](video-3d.md#characters--the-pose-pipeline-model3dconfigpose): crossfades, morphs, bones, look-at and IK aimed at Scene objects by `"@id"`, a Scene object held by a bone with `attach`) in the world, in both modes. Its colour filters, its Grow Fill and the real-3D Overlay Effects with `inWorldScene: "onObject"` run in the world on the model itself, in Draft and Final alike, and it keeps its shadow. While an effect with `inWorldScene: "ownPass"` (RGB Split, Digital Glitch, Pixel Stretch, Slit Scan, Spectral Curtain, Flash Blink) is live, the model leaves the world for its own pass, and so does a model with a blur or any other flat effect: it then casts no shadow and Final does not trace it; it stays where the world showed it, lit and filmed as the world lights and films it. Effects with `inWorldScene: "skipped"` are not available on a model in a world Scene ([effects-depth.md](video-effects.md#in-a-world-scene-rigrenderer-world)). `"renderer": "classic"` turns the world off for the whole Rig.
- <a id="a-device-from-the-preset-table"></a>A device from the [preset table](video-3d.md#bundled-device-presets) (a phone, a tablet, a laptop, an iMac) goes in ready-made as a `model3d` layer on a channel of its own, not locked to the camera (that takes it out of the world): the clip's `url` is `model-preset:<id>`, and `model3dConfig` has `source: "preset"`, the same `preset`, that row's `baseRotation.y`, and its picture in `screen` (`{ "url": "/media/….png", "fitMode": "cover" }`, a video url, or `layer`); `screens` naming a preset's display stays black under its cover glass. It stands where `panX` / `panY` (% of the frame) and `panZ` (px) put it, one world unit being 1000 px, as [3D Text](#placing-3d-text-in-the-world) does, and under `scene.camera` it stays at that place in the world. With `fit: "height"`, `fitValue` is its height in % of the frame's height (55 on a 1920-tall frame is 1.056 units); `anchor: "base"` puts its lowest point at its place, so it stands on a floor at height y with `panY` = −y × 1000 / H × 100. `placeOnRigFloor` stands it only on the Rig's cyclorama floor, so set it `false` on a floor of your own. The Scene's lights and environment light it (the layer's own `env`, `lights` and `shadow` are not read there), it casts and takes the Scene's shadows, and its screen glows in Draft and Final and lights the set in Final. Example below.
- A material's `maps` and an object's `model` take media URLs (`"maps": { "base": "/media/…" }`, `"model": "/media/….glb"`). `env.hdri` takes an `.hdr` URL. A picture in `maps.base` is multiplied by the material's `base`, so leave `base` out (white) to show the picture's own colours.
- The environment lights everything, shadows included, so it sets how dark a sun's shadow can be. With the studio preset and a sun at 3, Final measured the shadow at 58% of the lit floor with the environment at 0.05, 87% at 0.2 and 98% at 0.6, where the frame is nearly white. For a sunny look with clear shadows keep the environment at 0.05 to 0.15; the 0.6 above is a soft studio look.
- `"lights": []` on a Rig with `"renderer": "world"` means no Rig lights: the scene's own lights and the environment light the world. Leave `lights` (or `renderer`) out to get the Rig's default key, fill and rim, which cast no shadows and so lighten every shadow your sun casts. An `ambient` or `hemisphere` Rig light adds its intensity to the environment's and its colour tints the share it adds, as it rests and as a colour key (`scc:<lid>:col`) moves it, as on a classic Rig (a red one at 1.5 over an environment at 0.5: the 1.5 it adds is red, the environment's own 0.5 stays as it is; a dark `#20222a` at 0.05 adds almost nothing). A `hemisphere`'s `color` tints the environment's upper half and its `groundColor` the lower half. With no environment map (`env.source: "none"`) an `ambient` or `hemisphere` lights the world as a flat environment of its own colour, as bright as on a classic Rig. A Solid or picture backdrop is as opaque as its `opacity` (0.6 lets 40 % of the layers below through), at rest and keyed (`sc:cyc:opacity`).

A new Scene layer, whole, as it goes into the project's `clips` and `channels` (a `rig` clip's empty `url` is right; only `model3d` clips need one):

```json
"clips": [{ "id": "c-rig", "source": "LOCAL", "mediaType": "rig", "url": "", "name": "Scene", "duration": 6 }],
"channels": [{ "id": "ch-rig", "name": "Scene", "kind": "rig", "visible": true, "unsnapped": true,
  "items": [{ "id": "i-rig", "clipId": "c-rig", "trimStart": 0, "trimEnd": 6, "freeStart": 0, "rig": { "renderer": "world", "lights": [], "scene": { } } }] }]
```

A preset phone standing in that Scene with its picture on the display: on a 1080 × 1920 frame it is 1.056 units tall and stands on a
floor whose top is at y = −0.5 (`panY` 26.04), turned as an object at `rot: [0, -22, 0]` (add the clip to `clips` and the channel
after the Scene's):

```json
{ "id": "c-phone", "source": "REMOTE", "mediaType": "model3d", "url": "model-preset:iphone_pro_max", "proxyUrl": null, "name": "iPhone 17 Pro Max", "duration": 6 }
{ "id": "ch-phone", "name": "Phone", "visible": true, "unsnapped": true,
  "items": [{ "id": "i-phone", "clipId": "c-phone", "trimStart": 0, "trimEnd": 6, "freeStart": 0, "panX": 0, "panY": 26.04, "panZ": 0, "rotateY": -22,
    "model3dConfig": { "source": "preset", "preset": "iphone_pro_max", "fit": "height", "fitValue": 55, "anchor": "base", "placeOnRigFloor": false,
      "baseRotation": { "x": 0, "y": 180, "z": 0 }, "screen": { "url": "/media/admin/{board_id}/app-screen.png", "fitMode": "cover" } } }] }
```

## Filming the Scene with the Camera layer

The timeline's Camera layer ([video-camera.md](video-camera.md)) films a Scene that has no `scene.camera`: its keys, eases, path, rig, zoom and depth of
field are rows the user sees and edits in the editor. Every mode films the world: free keys (with a look-at), a path, a Camera Rig and the
Zoom mode. The video guide's motion rules hold for the camera and for Scene objects as for 2D layers: a move is two keys and one of the
app's eases, chained keys carry the speed, curves ride a path ([video-design.md](video-design.md#motion-grammar), [video-keyframes.md](video-keyframes.md#easings)).

### Units and axes

- The camera's world is the Scene's: x right, y up, z toward where the camera stands at rest. **One metre is 1000 px.**
- At rest (no keys) the camera stands at `[0, 0, D / 1000]` m looking down −z at the origin: D = H / 2 / tan 14°, 2166 px on a 1080-tall
  frame, 3850 px on a 1920-tall one. Its field of view is 28° vertical: a 40.6 mm lens on a 16:9 frame, 72 mm on 9:16 (the film is 36 mm
  along the frame's longer side, as in Final).
- `camZoom` is the lens: `camZoom = tan 14° / tan(fov / 2)`; a lens of L mm is `fov = 2 · atan((36 / max(W / H, 1)) / (2 · L))`.
- A target is a Scene object written `"@<object id>"` (where its origin stands at that moment, its keys, drives, path and parents
  included, on the Scene clip's own clock), a timeline item id, or a point `{ "x", "y", "z" }` in px. The camera names targets in
  `cameraLookAt`, `cameraFocusOn`, `cameraPath.targetId`, `cameraRig.center` and `.targets`, and a zoom range's `target`.
- **The helper.** `POST /api/world3d/camera-layer` turns a camera written in the world's terms into the Camera layer's fields, so an agent
  never works out pan, dolly and tilt by hand. Nothing is written.

  ```json
  { "size": [1920, 1080], "pose": { "at": [1.6, 1.1, 2.6], "target": [0, 0.25, 0], "lens": 40, "roll": 0, "focus": 3.17, "fStop": 2.8 } }
  ```
  answers `{ "fields": { "camX", "camY", "camDolly", "camTiltX", "camTiltY", "camRoll", "camZoom", "camDofEnabled", "camFocusDistance",
  "camFStop" } }`: base values, or one key's values. `poses` takes a list (one per key). With `"lookAt": true` it answers
  the fields of a camera that turns to its target itself (`cameraLookAt`): its place on the world's axes, `camX = x · 1000 / W · 100`,
  `camY = −y · 1000 / H · 100`, `camDolly = D − z · 1000`, with `camZoom` and `camRoll`. `"camera": { … }` (a whole `scene.camera` with its
  keys) answers a Camera layer `clip` and `item` with the keys fitted to it; `"data": { … }` (a project) answers the project with its
  Scene's camera moved onto the Camera layer.
- **Depth of field.** `camDofEnabled`, `camFocusDistance` (px) and `camFStop`, the lens's f-number (keyable): the blur follows the focus
  and the zoom as a real lens's, so a focus pull or a zoom keeps the f-number. `cameraFocusOn: "@id"` holds the focus on an object.
  Without `camFStop`, `camAperture` is the blur of the far background in px, the same at every focus and zoom. Draft blurs the Scene
  through the same thin lens Final traces. The focus area (`camFocusWidth`) and `camHighlightGain` shape flat layers only; the Scene has
  none, as in Final.
- **Roll** (`camRoll`, + cants the horizon clockwise) turns the view about its own line of sight on a camera that aims: a look-at, a
  path's aim, a rig. On a free camera without a look-at the turns are the editor's (Tilt X, then Tilt Y, then the roll about the
  composition's z): there a roll on a tilted camera also swings it round, so give a turning, rolling shot a look-at (a point
  `{ "x", "y", "z" }` px will do) or take every key's turns from the helper.

### A free move: a push-in with a slight orbit and a focus pull

The camera's place on two keys and one ease; `cameraLookAt` keeps the hero in the middle all the way (no tilt keys), so the push-in
also orbits it a little; a 50 mm lens at f/1.4; the focus racks from the cone far behind to the hero on three keys (the f-number holds,
so the blur follows the focus). The places came from the helper (`"lookAt": true`, `at` [2.4, 1.3, 3.4] → [0.75, 0.85, 2.0], `lens` 50) and the focus distances
from the shot evaluator at 1, 2.6 and 4 s ([below](#check-the-framing-without-a-final)). Times are in % of the 4 s camera clip.

```json
{ "cameraMoveMode": "free", "cameraLookAt": "@hero", "camZoom": 1.2312, "camDofEnabled": true, "camFStop": 1.4,
  "propertyKeyframes": {
    "camX":     [{ "position": 0, "value": "125", "easing": "AE Smooth" }, { "position": 100, "value": "39.0625", "easing": "AE Smooth" }],
    "camY":     [{ "position": 0, "value": "-120.3704", "easing": "AE Smooth" }, { "position": 100, "value": "-78.7037", "easing": "AE Smooth" }],
    "camDolly": [{ "position": 0, "value": "-1234.1783", "easing": "AE Smooth" }, { "position": 100, "value": "165.8217", "easing": "AE Smooth" }],
    "camFocusDistance": [{ "position": 25, "value": "6598", "easing": "Smooth" }, { "position": 65, "value": "2462", "easing": "AE Smooth" },
                         { "position": 100, "value": "2157", "easing": "AE Smooth" }] } }
```

- With a look-at, `camX`, `camY` and `camDolly` are the place on the world's axes whatever the zoom, and the tilt rows have no say. Without
  one they are the helper's turned pan and dolly (the pan divided by the zoom): write the helper's fields as they are.
- `"cameraFocusOn": "@hero"` instead of the focus keys holds the focus on the hero on every frame.

### A path move: a crane and orbit round an object

Three anchors in px rising from the left front to the right, both handles on each (the [tangent rule](video-shapes.md#writing-the-handles)),
aimed at the hero, a 35 mm lens; `camPathT` carries the move on two keys.

```json
{ "cameraMoveMode": "path", "camZoom": 0.8619,
  "cameraPath": { "follow": true, "closed": false, "aim": "target", "targetId": "@hero", "points": [
    { "x": -2200, "y": 450, "z": 1500, "hIn": { "x": -733.3, "y": -216.7, "z": -333.3 }, "hOut": { "x": 733.3, "y": 216.7, "z": 333.3 }, "manual": true },
    { "x": 0, "y": 1100, "z": 2500, "hIn": { "x": -716.7, "y": -225, "z": 33.3 }, "hOut": { "x": 716.7, "y": 225, "z": -33.3 }, "manual": true },
    { "x": 2100, "y": 1800, "z": 1300, "hIn": { "x": -700, "y": -233.3, "z": 400 }, "hOut": { "x": 700, "y": 233.3, "z": -400 }, "manual": true } ] },
  "propertyKeyframes": { "camPathT": [{ "position": 0, "value": "0", "easing": "AE Smooth" }, { "position": 100, "value": "100", "easing": "AE Smooth" }] } }
```

An orbit is a closed path round the object (`"closed": true`, four anchors at its sides); a dolly along a spline is `aim: "tangent"`.

### A rig: a built-in Camera Rig round an object, and a saved preset

The built-in Hero Orbit ([video-camera.md](video-camera.md#built-in-rigs)) built round the hero with `center`, its focus held on it, its lens and
timing from a saved camera preset. A rig's numbers are px round its centre: `radius` 1800 is 1.8 m, `height` 400 stands 0.4 m above
(negative is below), `startAngle` 0 is in front (+z) and 90 to the right (+x), `tilt` moves the point it looks at by
`height · tilt / 45` px up.

```json
{ "cameraMoveMode": "rig", "cameraFocusOn": "@hero",
  "cameraRig": { "type": "orbit", "radius": 1800, "height": 400, "startAngle": -40, "sweep": 90, "tilt": -8, "aim": "center", "center": "@hero" },
  "camZoom": 1.3, "camDofEnabled": 1, "camFStop": 2,
  "propertyKeyframes": { "camPathT": [{ "position": 0, "value": "0", "easing": "AE Smooth" }, { "position": 100, "value": "100", "easing": "AE Smooth" }] } }
```

The lens and timing are the preset "Hero lens", saved with `POST /api/camera-presets`
`{ "name": "Hero lens", "duration": 4, "keyframes": [{ "position": 0, "easing": "AE Smooth", "properties": { "camPathT": "0" } },
{ "position": 100, "easing": "AE Smooth", "properties": { "camPathT": "100" } }], "base": { "camZoom": 1.3, "camDofEnabled": 1, "camFStop": 2 } }`
and loaded from `GET /api/camera-presets` onto any camera: `base` as base values, each key's properties as tracks
([video-camera.md](video-camera.md#camera-presets-save--load-reusable-camera-moves)). A preset that carries only `camPathT`, the lens and depth of
field composes with a rig; one that keys the pose sets the camera to `"free"`.

### A zoom onto a Scene object and back

A wide shot that looks at the hero, then the Zoom mode: one range on the camera clip's own time (ms) with its `target` and `zoom`. The
camera stays where it stands; it turns its head to the target and the lens zooms in by `zoom` (times its own `camZoom`), then comes back
after `endMs`. The range has no keys: the preset's spring eases it in and out. `calm` is the smoothest start (its speed builds over
about five frames); `studio`, `precise` and `lively` start in two or three, a snap. With depth of
field on, the focus goes to the target and the blur grows as a real lens's does, so the f-number stays (here f/1.6 all the way, with
or without `camFStop`).

```json
{ "cameraMoveMode": "smartZoom", "cameraLookAt": "@hero", "camX": 0, "camY": -125, "camDolly": -1434.1783, "camZoom": 0.7387,
  "camDofEnabled": true, "camFStop": 1.6, "camFocusDistance": 3690,
  "smartZoom": { "clipId": null, "preset": "calm",
    "ranges": [{ "id": "z1", "startMs": 600, "endMs": 2700, "mode": "fixed", "zoom": 3, "target": "@ring" }] } }
```

A range with no `target` turns to its `point` (0..1 of the frame as it was before the zoom). Plain zoom keys on `camZoom` are a lens zoom
too (the field of view narrows; the camera does not move).

### From scene.camera to the Camera layer

| `scene.camera` | The Camera layer |
| --- | --- |
| `at`, `target` | the helper's `camX`, `camY`, `camDolly`, `camTiltX`, `camTiltY`; or `cameraLookAt` with the place on the world's axes; a path's points with `aim: "target"`; a rig round `center` |
| `fov`, `lens` | `camZoom = tan 14° / tan(fov / 2)` (the film is 36 mm along the frame's longer side) |
| `up`, a banking camera | `camRoll`, keyable, about the line of sight |
| `keys` on `at`, `target`, `fov`, `focus` | keys on the same tracks; an ease's id is its editor name (`aeSmooth` is `AE Smooth`, `easeInOut` `Smooth`) |
| `fx` on its keys | `propertyKeyframeFx` on the track (Glide, Spring, Elastic, Bounce, Wiggle, Custom) |
| `fStop`, `focus` | `camDofEnabled`, `camFStop`, `camFocusDistance` (px, `focus` × 1000); `focus: "@id"` is `cameraFocusOn: "@id"` |
| `drive` on the Scene's clocks | keys on the camera's tracks (the Camera layer runs on the timeline, not on the Scene's clocks) |
| the shot's motion blur | the same: a Camera layer move blurs in Draft and is traced once in Final |

<a id="what-only-scenecamera-does"></a>**What only `scene.camera` does.** An orthographic or fisheye `projection`, `shift`, a tilted plane of
focus (`tilt`), bokeh shape (`blades`, `bokehRotation`, `anamorphic`, `catEye`), exposure from `iso` and `shutter`, its `distortion` (the
Camera layer's `camLensK1` is a solved footage lens), `autoExposure`, `noise`, `exposureCompensation`, a `device`, `sensor` / `sensorFit` /
`frame`, and drives on the Scene's clocks. For a shot that needs one of them, write `scene.camera` and say which one in your report.

### Check the framing without a Final

- **Where the camera is, at any time, with no render:** `POST /api/moodboards/{board}/video-projects/{project}/camera-shot`
  `{ "times": [0, 1, 2, 3, 4] }` (or `/api/world3d/camera-shot` with the project's `data`; or `start`, `end`, `every`) answers each time's
  `{ t, camera, mode, at, target, up, fov, lens, zoom, dof: { on, focus, fStop, aperture }, pose }` in metres and degrees. With
  `"objects": [{ "id", "bbox": { "min", "max" } }]` (a still's `scene.inspect.objects`) each time also says what share of each box is in frame
  (`inFrame`).
- **What it sees in a still:** a Draft `render-still` with `"inspect": true, "critique": true`: `scene.view` names who filmed it
  (`"films": "cameraLayer"`) and from where; `scene.inspect.inFrame` and `critique.objects` measure through the Camera layer at the still's
  time; `critique.path` (`"camera": "layer"`) checks the Camera layer's move over the whole Scene clip and names an object it takes out of the
  frame.
- `POST /api/world3d/validate` with the project's `data` names a Scene object a camera targets that does not exist (`"@hero"` misspelled,
  with `didYouMean`), a rig or path with no `camPathT` keys (it stands still), path anchors without handles, and a Scene that films from
  its own camera (`scene_camera`).


## The scene format

A scene is plain JSON. An agent writes it, the project stores it, and the renderer reads it. Every field below is optional;
an object with no `graph` is a plain group. The renderer silently ignores a field it does not know, so a misspelled one (`transmision`)
changes nothing in the picture: check every scene with `POST /api/world3d/validate` before rendering, and ask
`GET /api/world3d/help?path=…` about any field ([Check your work](#check-your-work)). The whole schema, every field with its type,
range and default, is [world3d-schema.json](world3d-schema.json) next to this page.

```json
{
  "env": { "hdri": "/media/…/studio.hdr", "intensity": 1, "rotation": 0, "background": "env" },
  "lights": [{ "id": "key", "type": "sun", "dir": [0.4, 1, 0.3], "color": "#fff4e6", "intensity": 3, "size": 2 }],
  "materials": { "oak": { "base": "#8a6a4c", "roughness": 0.55, "metalness": 0, "maps": { "base": "/media/…/oak.png" }, "uvScale": [2, 2] } },
  "objects": [
    { "id": "desk", "name": "Desk", "parent": null, "at": [0, 0, 0], "rot": [0, 0, 0], "scale": [1, 1, 1], "material": "oak",
      "graph": [{ "op": "box", "size": [1.6, 0.04, 0.8], "bevel": 0.004 }],
      "keys": { "at": [{ "t": 0, "v": [0, 0, 0], "ease": "out" }, { "t": 1, "v": [0, 0.1, 0] }] } }
  ],
  "layers2d": [{ "id": "title", "kind": "text", "text": "Hello", "at": [0, 0.3, 0], "height": 0.1 }],
  "sims": [{ "recipe": "sparks_in_wind", "id": "sparks", "at": [0, 0, 0] }]
}
```

Units are metres and degrees. Y is up. Times are seconds. The Scene clip's length and the project's frame rate set the duration and
fps, so a scene carries none (`version`, `duration` and `fps` are ignored here). Every time in a scene (a key's `t`, a sim's start, a
scene object's animation, a `screen` video by url) counts from its Scene clip's own start, not the timeline's: a Scene layer at 3 s plays its `t: 0`
at 3 s, and moving the layer along the timeline moves its whole animation with it. Before the clip it holds its first frame, after it its last.

- `camera` is the Scene's own camera (`at`, `target`, `fov` and the fields below). The Camera layer films the Scene unless it has one; the
  fields below are for the shots [only it does](#what-only-scenecamera-does).
- The camera's `fov` is vertical. `camera.fStop` and `camera.focus` (metres, keyable) give the scene camera depth of field: Final traces
  the thin lens, and Draft blurs each pixel over the same lens's circle for its depth, up to a 12th of the frame's height across (a
  macro shot's far background, which Final blurs further, stays a little sharper in Draft). The lens is the focal length that gives `fov` on the
  camera's film: at 16:9 on 36 mm across, fov 28 is about 41 mm and fov 20 about 57 mm. Set `lens` (mm, keyable) instead of `fov` to choose it directly.
- The film is `sensor` [36] mm along the side `sensorFit` names, as Blender's Sensor Fit: `"AUTO"` (the default) the frame's longer
  side, `"HORIZONTAL"` its width, `"VERTICAL"` its height (then `sensor` is Blender's sensor height). It decides how much an `fStop`
  blurs at a given `fov`: a portrait 1080 x 1920 frame with `"sensorFit": "HORIZONTAL"` (Blender's usual vertical film) has 36 mm across
  and 64 mm up, so its fov 41.3 is an 85 mm lens with Blender's blur; the same fov on `"AUTO"` reads as 48 mm with about half the blur.
  `frame` [width, height] is the frame `fov` was taken on: rendered at another shape, the view is refitted as Blender frames it (the
  fit's side keeps its view). A `.blend` import writes `sensor`, `sensorFit` and `frame`; a hand-written camera needs none of them.
- The camera sees the whole set however big it is: its far plane follows the set's farthest corner (and a sim's `area`), never under
  200 m, and its near plane stays 2 cm (it rises with a very big set, never past half the way to the nearest thing). Nothing past 200 m is
  cut any more, in Draft or Final.
- Orthographic camera (isometric product and architecture shots): `"projection": "ortho"` with `orthoHeight`, the frame's height in metres
  (its width follows the video's aspect; left out, the frame the perspective camera has at `target`). Rays are parallel, so a thing is as
  big far as near and lines that are parallel in the world stay parallel. With `fStop` it has a depth of field (Final and Draft): its
  aperture is 1 / (2 fStop) metres in radius, as Cycles' orthographic camera (f/10: 5 cm), and a point at distance d blurs over aperture ×
  |d / focus − 1| of the frame; a scene scaled down from a .blend scales that aperture with it (a larger `fStop` by the same factor). The camera still stands at `at` and
  looks at `target`: nothing between it and its near plane, or behind it, shows, so stand it well back (`"at": [6, 5, 6], "target": [0, 0.4, 0]`
  is a classic isometric look down on a set at the origin). `orthoHeight` is keyable (an orthographic zoom). A model layer that leaves
  the world for its own pass (a blur, a flat effect, one of the six that move its picture) is filmed orthographic too, and sorts with the
  world by depth as in a perspective Scene. The view out of the windows (`env.view`) stands as a flat backdrop for it (its `distance`).
  ```json
  "camera": { "projection": "ortho", "orthoHeight": 2.4, "at": [6, 5, 6], "target": [0, 0.4, 0] }
  ```
- A wide-angle lens as a lens model: `"projection"` `"stereographic"` (an action camera's wide lens: straight lines bow, faces and
  balls keep their shape; `fov` 72 is 116° across a 16:9 frame, 89 about 145°), `"equidistant"` (a classic fisheye, angles even across
  the frame) or `"equisolid"` (squeezes the edges more). `fov` is its vertical view (or `lens` mm through the model). Final traces each
  pixel's ray through the lens, so the middle stays as sharp as a straight lens's; Draft draws a straight lens wide enough to hold the
  corners (up to 80° off the axis; further out the corners stretch) and bends its picture, depth and masks, so its middle is softer the
  wider the lens (at fov 72 on 16:9 about 1.7 times upsampled). `distortion` adds its barrel on top. A fisheye has no Draft lens blur
  (Final traces `fStop`) and no `tilt`; a shadow catcher, local tone mapping (`look.localTone`) and glass over a see-through sky are
  not bent with it in Draft. `"device": "actionCam"` sets `"stereographic"`.
  ```json
  "camera": { "at": [-0.35, 0.06, 1.15], "target": [-0.63, 0.095, 0.15], "fov": 72, "projection": "stereographic" }
  ```
- Lens shift: `"shift": [x, y]` slides the frame by shares of its width and height without turning the camera, so verticals stay vertical
  (a view camera's rise and fall). For a building or a tall product seen from low down, keep the camera level (`target` at the same height
  as `at`) and raise the frame: `"shift": [0, 0.3]`. Works with both projections; keyable.
- Tilt-shift (Scheimpflug): `"tilt"` leans the plane of sharp focus that many degrees off the film, hinged on the `focus` point (an object,
  the target, or the point `focus` metres out on the axis); it needs `fStop`. Positive leans the plane's top away from the camera:
  `tilt` = 90 minus how steeply the camera looks down puts a whole ground in focus, near to far (for a camera looking down 35 degrees, 55).
  The "miniature" look is the other way round: a plane leaned almost onto the line of sight keeps only a thin band through the focus point
  sharp, the blur growing steadily above and below it: `tilt` -85 to -88 for a tabletop a few metres off, -89 to -89.5 for a street seen
  from tens of metres (or the same positive), with `fStop` 1.4 to 2.8; the nearer to 90, the thinner the band. The band is thinnest with the focus point near the middle of the frame: aim `target` at what should be sharp and slide
  the frame with `shift` to compose. `tiltRotation` turns the hinge about the view (90: a vertical sharp band). `tilt` is keyable. Final
  traces the tilted lens; Draft blurs by the same lens, so the band sits on the same rows in both. Flat text in the world
  (`textInWorld`) and splats blur by the same tilted plane, in Draft and Final.
  ```json
  "camera": { "at": [8, 20, 30], "target": [-0.75, 0.33, 9.3], "fov": 26, "shift": [0, 0.12], "fStop": 2, "tilt": -89.5 }
  ```
- Bokeh: `blades` (0 round, 5 to 9 a stopped-down lens's polygon), `bokehRotation` (degrees), `anamorphic` (an anamorphic lens's oval
  bokeh: that many times taller than wide, its height the round bokeh's, as Cycles' aperture ratio; 1.33 to 2 as real anamorphic lenses) and `catEye` (0 to 1: toward the frame's edges the lens barrel cuts each out-of-focus
  highlight into a lemon shape pointing at the middle, as on a fast lens wide open; 0.3 to 0.5 a vintage lens). Final traces them; they
  need `fStop`.
- Physical exposure: `iso` and `shutter` (seconds or `"1/125"`) with `fStop` set the picture's exposure as on a camera: ISO 100, 1/50 s,
  f/4 is exposure 1, and each doubling of ISO or of the shutter time, or each stop wider (`fStop` / 1.41), is one stop brighter. Only a
  camera that sets `iso` or `shutter` takes it (`fStop` alone stays depth of field); it multiplies the Rig's `exposure`, in Draft and
  Final, and `iso` and `shutter` are keyable (an exposure ramp, or an iris pull with `fStop` keyed too). The shutter here is exposure
  only; motion blur has its own settings.
- `distortion` bends the whole frame as a real lens does: above 0 barrel (a wide lens: straight lines bow outward), below 0 pincushion
  (a long lens); 0.05 to 0.15 reads as a real lens. The corners stay where they were (nothing goes black) and the picture, its depth and
  its masks bend together, in Draft and Final.
  ```json
  "camera": { "at": [0.6, 0.3, 1.4], "target": [0, 0.1, 0], "lens": 35, "fStop": 1.8, "focus": "@bottle", "catEye": 0.4, "iso": 400, "shutter": "1/100", "distortion": 0.06 }
  ```
- The camera as a physical device, for a shot that must read as footage (a robot's or a drone's camera, a phone in a hand, a camera taped
  to something): `autoExposure`, `noise`, `exposureCompensation`, or a `device` preset that sets them with the look's lens fields.
  Scene camera only; Draft and Final alike; nothing of it costs anything while unset.
  - `autoExposure: true` (or `{ lag, strength, min, max, metering, key }`) meters the picture and opens up or stops down toward a mid
    grey, lagging behind: driving from a sun patch under a table the picture stays dark for a moment, then opens up; out into the sun it
    blows out, then settles. `lag` [0.5] is the seconds it takes to cover about two thirds of a change into the dark (into the bright it
    takes half that); 0.3 to 0.4 a phone, 0.5 to 0.8 an action camera. `strength` [0.85] is how much of the way to mid grey it goes
    (1 makes every view as bright; under 1 dark places stay a little dark). `min` [-3] and `max` [3] are its range in stops.
    `metering` ["center"] is `"center"`, `"average"` or `"spot"`; `key` [0.18] the grey it exposes for. What lies past the sensor's
    white point counts as white, so a bright window in view pulls the room down a little, not into black. It meters the light as the Rig's
    `exposure` and the camera's `iso`, `shutter` and `fStop` expose it, so those still move the picture, by (1 - `strength`) of their
    stops; `exposureCompensation` moves it by all of its stops. The exposure at a frame is a
    pure function of the Scene's own clock (its meter samples the set 20 times a second, posed as the frames there are, over the five lags
    before it), so a still and the same frame inside a whole render agree. The meter reads the set, model layers and the Rig's
    keyed lights as Draft lights them; sims and 3D Text are not part of what it reads. A Camera layer filming the Scene has none.
    The still's `scene.autoExposure.stops` is the gain it chose on that frame (log2).
  - `noise` [0] is sensor noise in the light before the film curve: its strength grows with the camera's gain (`iso` / 100, the
    compensation and the auto-exposure's gain) and toward the shadows, a fine luminance grain with coarser colour blotches, new on every
    frame. 0.3 a clean cinema sensor, 0.5 a phone, 1 an action camera. In a sunlit part it is nearly gone; under a table the
    auto-exposure opened up two stops it is plain to see. `look.grain` stays film grain, even everywhere (also new on every frame).
  - `exposureCompensation` (stops, keyable) moves what the auto-exposure exposes for, or the exposure itself without one.
  - `device`: `"actionCam"` (auto-exposure lag 0.6 s, average metering, strength 0.8, range -3 to +4; noise 1; a stereographic
    lens, `projection` below; look aberration 0.45, vignette 0.28, bloom 0.06 over 1.2), `"phone"` (lag 0.35 s, centre metering, strength 0.9, -3 to +5; noise 0.5;
    distortion 0.03; aberration 0.12, vignette 0.1, bloom 0.05, localTone 0.35), `"cinema"` (no auto-exposure; noise 0.25; halation 0.05,
    vignette 0.15, bloom 0.06). It fills only what the camera and the look leave out: a field the scene writes wins, 0 included.
  - Window glare is `look.bloom`: it glows from the light as exposed, in proportion to how far over `bloomThreshold` it is, so a window
    many times over white flares and a white wall does not. With `autoExposure` opening up in a dark room the window flares more, as a
    camera's does.
  ```json
  "camera": { "at": [-0.35, 0.06, 1.15], "target": [-0.63, 0.095, 0.15], "fov": 72, "device": "actionCam",
    "keys": { "at": [{ "t": 0, "v": [-0.35, 0.06, 1.15], "ease": "linear" }, { "t": 7, "v": [-0.35, 0.06, -1.25] }] } }
  ```
- Lights are in [Lights in the scene](#lights-in-the-scene): where each kind stands and where it points.
- `env` (`hdri`, `intensity` [1] (it scales `flat` too), `rotation` degrees, `tint`, `flat`, `background`, `opaque`) merges over the Rig's environment
  (`rig.env`, a bundled preset by default; `hdri` takes an `.hdr` URL, the presets are `/hdr/<preset>.hdr`). It lights everything, but
  where no object is, the frame shows what lies below the Scene layer (the project background, black by default), not the panorama:
  set `"opaque": true` to see the environment there (a sky through a window, a studio around a product), or `background` to a colour
  (`"#e9e4dc"`) for a plain backdrop. `"background": "none"` keeps the frame see-through even so. A colour background is only what the
  camera sees where no object is: the panorama still lights the scene and shows in reflections. The environment's strength has one
  source: the scene's `env.intensity` when it sets one, else `rig.env.intensity` (the Rig panel's Environment Intensity). A Rig strength moved
  off its default 1 does nothing while the scene sets another (its keys still scale the scene's in proportion): the validator and the
  still's `scene.warnings` say so at `rig.env.intensity`; keep one of the two.
- `env.view` is the view out of the windows: a picture the eye sees where the sky shows (through an opening or a `pane`), at the
  picture's own resolution, while the room is lit by the environment as before (nothing that lights reads it). Without one the sky
  map shows there, a 1k panorama blurred about 8 times through a window at 1080p. A photo of the street: `"view": { "image":
  "/media/…/street.jpg", "fov": 90, "dir": [-1, 0.05, -0.4] }`: `fov` [60] degrees across the picture's width, `dir` where its middle
  looks in the world (out of the window, a little toward where the camera looks through it), `up` [[0, 1, 0]]; take it wider than the
  window as seen from the camera (90 to 110), as its outer 2.5 % fade into the sky. A whole equirect panorama (2:1) is
  `"panorama": true`, turned with `rotation`. `intensity` [1] is its brightness as a share of the sky it covers (1 gives it the
  environment's mean brightness over the same directions: no exposure of its own; 1.5 to 3 for a street a few stops brighter than
  the room, as a camera exposed for the room sees it). `haze` [0] lays the picture's own mean over it (dirty glass, the air across a
  street: 0.15 to 0.3 from inside a room). Needs `background` `"env"` (and `opaque`). An orthographic camera's rays are parallel, so
  it sees the picture as a flat backdrop `distance` [20] metres out from the scene's origin along `dir`, as wide as `fov` makes it there:
  each window shows the part straight behind it. Nearer (`"distance": 8`) shows more of the picture through a window; a perspective
  camera ignores it. A `panorama` view is a sky at infinity: an orthographic camera sees its one colour along the view, as of the sky.
- Keys: a keyable field (an object's `at`, `rot`, `scale`, `shape:<name>`, the camera's `at`, `target`, `fov`, `focus` and the rest) takes
  `"keys": { "<field>": [{ "t": 0, "v": …, "ease": "…" }, …] }`, `t` in seconds on the Scene clip's clock (a key before 0 starts a move
  that is already under way on the first frame). It holds the first key's value before it and the last key's after it. Several things
  moving as ONE move are not separate keys on each: they are one clock and a drive on each field ([Motion design](#motion-design-one-clock-per-move)).
  `ease` shapes the move from its key to the next (`inOut` when left out):
  - the world's own: `linear`, `in`, `out`, `inOut` (cubic), `back`, `bounce`;
  - any keyframe easing of the Video Editor, played exactly as the editor plays it, by id or by the name the editor's keys write:
    `aeSmooth` (`AE Smooth`), `aeIn` (`AE In (arrive)`), `aeOut` (`AE Out (leave)`), `easeInOut` (`Smooth`), `easeIn`, `easeOut`,
    `natural`, `appleOut`, `smoothGlide`, `glideStop`, `punch`, `power`, `slowDown`, `sineIn` / `sineOut` / `sineInOut`, `cubicIn` /
    `cubicOut`, `expoIn` / `expoOut` / `expoInOut`, `backIn` / `backOut` / `backInOut`, `bounceOut`, `elasticOut`, `overshoot`,
    `smoothOvershoot`, `impulse`, `swing`, `anticipate`; `hold` stays on its key's value until the next key (a jump);
  - your own curve, the editor's Custom: `[x1, y1, x2, y2]` as CSS `cubic-bezier()`, x the share of the time between the two keys
    (0 to 1), y the share of the move (below 0 or above 1 overshoots; -3 to 4). A curve measured from a reference fits here directly:
    `{ "t": 0, "v": 1.288, "ease": [0.42, 0, 0.18, 1] }`.
  [video-keyframes.md](video-keyframes.md#easings) says which curve suits which move.
- Show and hide an object at a time with its `visible` keys: `"keys": { "visible": [{ "t": 0, "v": false }, { "t": 1.5, "v": true },
  { "t": 4, "v": false }] }`. Each key switches it (and its children) on or off at its `t`, in Draft and Final: hidden, it is not drawn,
  casts no shadow, shows in no reflection and gives no light. It is never half there: with motion blur on, the frame's own time decides
  for its whole shutter, so the switch lands between two frames and the object's other keys still blur. `ease` does nothing on these
  keys. Use it for cuts between sets and for parts that appear, instead of scaling a thing to almost nothing. A still's `critique` and
  `inspect` report an object its keys hide as hidden, not as out of frame: `hiddenByKeys` `[{ id, at, until, by }]` (`at` the time of
  the key that hides it, `until` when a key shows it again or null, `by` the parent whose keys hide it), and a hint saying so. Draft's
  light estimates made for the set (the sky through its openings and the walls' light, an open set's surroundings, a sized spot's
  share of its disc) are made again at each switch, for the objects shown then: Draft after the switch is the Draft of a Scene that
  starts that way. A render waits for them on the switch's frame (about a second on a room; nothing for an open set's switch).
- An object takes `castShadow: false` (it throws no shadow, in Draft and Final: light, the environment's included, passes it; a
  glowing plate far behind a window still lights the set with its glow in Final) and `receiveShadow: false`. Its `tags` let lights pick
  it (light and shadow linking), `visibility` says which kinds of rays see it, and `holdout: true` cuts it out of the picture as a
  matte ([Which light reaches what](#which-light-reaches-what-tags-light-linking-and-shadow-linking), [What each kind of ray sees](#what-each-kind-of-ray-sees-visibility-holdout)).
- `"portal": true` marks an opening the environment's light comes in through: the window or open door of a closed room. Give it a flat `plane` the size of the opening, standing in it (`{ "op": "plane", "size": [w, h] }` then `{ "op": "transform", "rot": [90, 0, 0] }` for a wall that faces ±z), placed at the opening's inner face. It is never drawn, casts nothing and does nothing without an environment. In Final most of the environment's light samples then aim through the scene's portals, so a room lit only through its window is clean much sooner; light that comes in elsewhere is still found. Up to 8 portals; leave them out of an open set (no ceiling or missing walls). A set built with the `room` op needs none: while the camera is inside that room its window openings are portals by themselves (doors are not), unless the scene has portal objects of its own (then only those count).
- A material with `emission` lights the set in Final as a light: a screen, lit keys, an LED panel or a bulb is sampled directly, so the light it throws on what is near is clean at the usual samples (emission maps included: a screen lights the keyboard in its own colours). Glows share the light samples with the lights and the environment by how much each brings where it lands, so a small glow beside a sun costs the sun nothing. Not for a glow that is transparent, alpha-cut, translucent or subsurface, on a mesh with several materials, skinned or with shape keys, past the 16th glowing object or 65 536 glowing triangles, nor in a scene with a Grow Fill or a `reveal`: those glows still light the set, only noisier.
- A material with `screen` shows a video or a layer of the same project on any object (a tablet, a TV, a billboard built with ops): `"screen": { "url": "/media/….mp4" }` or `{ "layer": "<item or channel id>" }` (an HTML clip live from its page with no bake, a video in step with the timeline, an image). The picture lies over the object's UVs as a map in `maps` does (give it `uvPlanar` with `fit`, or `uvBox`), and glows (`"shading": "screen"`, default) or is the surface's colour under the set's light (`"lit"`). `look: "monitor"` makes it a monitor: glass coat with soft reflections (`glass` [0.1], its roughness) over a near-black panel, blacks lifted by `blackLevel` [0.02]. `strength` [1] scales the glow; the material's `uvScale` / `uvOffset` / `uvRotation` place the picture on the uvs as they place its maps (a converted device's display keeps the window of its atlas the import wrote there, so put `screen` on that material or copy those three fields; outside 0..1 the picture's edge pixels stretch, it does not repeat); `fit` `cover` (default) / `contain` / `stretch`; a url video takes `offset` (seconds) and `loop` [true]; `resolution: [w, h]` lays an HTML page out at that size. The material's own fields (`base`, `roughness`, `coat`, …) still win. A glowing screen lights the set in Final as a light (see `emission` above), following the picture it shows; with `look: "monitor"` Draft gets a soft light from it too, in the picture's average colour (no shadows; `"light": false` leaves it out). A model's glowing screen (`model3d` `screens`) without that look lights, in Draft, what stands in front of it within about one and a half screen diagonals (a keyboard under a monitor). The canvas is the source's own size and is uploaded again only when the source shows another frame: a paused video or a still page never restarts Final. MP4/MOV only for video.
- A spot light with a `radius` is a disc of light that glossy surfaces reflect cleanly in Final (as an area light is), not only a soft shadow.
- `layers2d` are flat pictures and words standing in the world: `kind: "image"` with `src` (a media url), or text (`text`, `fontPx` [160], `weight` [700], `font`, `color` [`#ffffff`]). `height` is in metres [0.2] (or give `width`; the other follows the picture), `at` and `rot` place it, `opacity` fades it. Objects in front hide it unless `ignoreDepth: true`. `receiveShadow: true` makes it a lit card that takes the set's shadows, and `castShadow: true` throws its shape's shadow. `screen: { "x", "y" }` (0..1 of the frame) pins it to the screen instead, with `height` then a fraction of the frame height [0.05]. `kind: "layer"` with `layer: "<item or channel id>"` stands a layer of the same project in the world as a card: an HTML clip (live, no bake), a video or an image, at its own aspect, hidden by what is in front and hiding what is behind, in Draft and Final; with `receiveShadow: true` it is lit by the set and traced in Final, without it it keeps its exact colours. Hide the source layer's channel to show it only in the world. In the editor only `kind: "layer"` cards reach the world. `"parent": "<object id>"` makes a card ride a scene object (`at` and `rot` an offset in its space), and `drive` and `fx` move it like an object's ([Motion design](#motion-design-one-clock-per-move)).
- `sims` are simulations on the GPU (particles, smoke and fire, curves, and cloth, hair, sand and soft bodies; more solvers to come): a recipe such as `sparks_in_wind`, `pulse_explosion` or `cloth_drop_on_sphere`, or a whole `sim/1` graph of emitters, forces, fields, colliders and agent-written step snippets. They draw as lit objects, are traced in Final, and repeat exactly on every scrub and render. Everything about them is in sim.md (GreenLight Dash only). (The old `particles` field is gone and is ignored.)

### Materials

A material is a name in `scene.materials` that objects point at with `material` (or `materials` by slot). Every field is optional:

| Field | Range [default] | What it does |
|---|---|---|
| `base` | colour [`#ffffff`] | Surface colour (sRGB). Multiplies `maps.base` and a pattern's colours. |
| `roughness` | 0–1 [0.5] | 0 mirror, 1 matte; on glass it frosts the glass. |
| `metalness` | 0–1 [0] | 1 is metal. For real metals use `metal` (below). |
| `specular` | 0–2 [1] | Strength of a non-metal's reflection. |
| `coat`, `coatRoughness` | 0–1 [0, 0.1] | A clear lacquer on top. |
| `sheen`, `sheenColor`, `sheenRoughness` | 0–1, colour, 0–1 | Velvet rim light: cloth, felt. |
| `fabric` | true or `{ weave, threads, relief, contrast, variation }` | Cloth that reads as cloth: see [cloth](#cloth-fabric). |
| `pane` | bool [false] | Thin window glass: see [glass and liquids](#glass-and-liquids). |
| `transmission`, `ior`, `thinWalled`, `attenuationColor`, `attenuationDistance`, `priority`, `dispersion` | see [glass and liquids](#glass-and-liquids) | |
| `emission`, `emissionStrength` | see [glowing surfaces](#glowing-surfaces) | |
| `alpha` | 0–1 [1] | Opacity. Not for glass: glass is `transmission`. |
| `alphaMode`, `alphaCutoff` | `"blend"` \| `"hash"` \| `"clip"` [`"blend"`], 0–1 [0.5] | How a cut-out (`maps.alpha`, or `alphaFromBase`) is drawn. `clip`: solid above `alphaCutoff`, gone below, in Draft and Final: petals, leaves, a die-cut label (crisp, no sorting). `hash`: dithered in Draft, no sorting, for soft cuts (gauze, hair cards). `blend`: see-through by its alpha, sorted. Final traces `blend` and `hash` by their exact coverage. A cut-out on a transmissive material cuts in Final too. |
| `doubleSided` | bool [false] | Draw both sides: sheets need it, closed solids do not. |
| `maps` | `{ base, normal, roughness, metalness, emission, transmission, alpha }` | Media URLs, following the mesh's uvs. `normalStrength`, `normalFlipY`, `alphaFromBase` go with them. |
| `uvScale`, `uvOffset`, `uvRotation` | [u, v], [u, v], degrees | Repeat, shift and turn every map and pattern. `uvOffset` [0.5, 0] moves the picture half a tile toward −u (it shifts where the map is read). |
| `procedural`, `translucency`, `subsurface`, `iridescence`, `metal`, `anisotropy`, `roundEdges`, `displacement`, `reveal` | below | |
| `flakes`, `coatBump`, `dust`, `toon` | [car paint, dust, toon](#car-paint-dust-and-toon-flakes-coatbump-dust-toon) | |
| `preset` | a name from [the material library](#the-material-library-preset) | Over a hundred ready materials; the material's own fields go over it. |

Three.js and Blender names do not work here: `emissive` is `emission`, `emissiveIntensity` is `emissionStrength`, `color` is `base`,
`opacity` is `alpha`, `clearcoat` is `coat`, `metallic` is `metalness`. The validator says so and names the right one.

#### Glass and liquids

```json
"materials": {
  "glass": { "base": "#ffffff", "roughness": 0.02, "transmission": 1, "ior": 1.5, "priority": 1 },
  "perfume": { "transmission": 1, "ior": 1.36, "attenuationColor": "#e8a440", "attenuationDistance": 0.3, "priority": 2 },
  "frosted": { "transmission": 1, "ior": 1.5, "roughness": 0.35 }
}
```

- `transmission` 1 makes the surface let light through and bend it: glass, water, perfume, ice. `roughness` 0 to 0.05 is clear glass,
  0.2 to 0.4 frosted. `ior` is how much it bends: 1.33 water, 1.36 alcohol and perfume, 1.45 oil, 1.5 glass, 2.42 diamond.
- A transmissive object on a **closed** mesh is a solid body, as real glass and Cycles' glass are: light bends going in and coming out,
  so a glass ball is a lens (the view behind it turned over, a bright caustic under it in Final), a bottle's walls, ice and the water in a
  glass refract. On an **open** mesh (a `plane`, a `grid`, a single-surface cup, a leaf) it is a thin wall that tints and reflects but bends
  nothing, so a sheet made of a plane reads as a pane. Draft and Final alike. `thinWalled: true` makes it a thin wall on any mesh (a soap
  bubble, a light bulb or a bauble modelled as one closed surface: the `soapBubble` preset has it); `thinWalled: false` a solid body on
  any mesh (a pool's or a sea's surface made of a plane). Model a bottle's glass with real walls (a `lathe` whose profile goes up the
  outside and back down the inside, or a `boolean` subtract of a smaller body) and the liquid as its own closed object inside: a lathe of
  one wall is open, a thin glass surface.
- `attenuationColor` is the colour the light takes on after `attenuationDistance` metres inside: the tint of the liquid. It is
  Beer–Lambert absorption: after `d` metres each channel keeps `attenuationColor ^ (d / attenuationDistance)` of its light, so a deeper
  body is darker and more saturated. Keep the distance near the object's own size: for a 10 cm bottle, 0.2 to 0.5 m reads as light
  amber, 0.08 to 0.1 as deep amber, 0.03 nearly black. Unset is clear. `base` on a transmissive material tints only its surface; the
  body's colour is `attenuationColor` (the validator says so when a liquid has a `color`).
- A liquid in its glass: give the liquid `priority` 2 and the glass 1, and let the liquid touch or slightly overlap the inner wall
  (a millimetre into it): where the two overlap, the higher priority is what is there, so no air film appears between them. A liquid
  that stops short of the wall shows a bright rim of air.
- Glass, water and ice that nest get 4 passes through surfaces free of `bounces` (above), so a drink or a bottle is right at the default;
  raise `bounces` for deeper stacks (a glass behind a glass behind a bottle), and `spp` to 128 or more for a glass close-up.
- `dispersion` (0.1 to 1) splits white light into colours in Final (crystal, prisms, gems): it is 20 divided by the material's Abbe
  number (glTF's KHR_materials_dispersion), so crown glass is 0.34, flint glass 0.5 to 0.6, diamond 0.36 (`ior` 2.42), sapphire 0.28.
  Final traces it spectrally: every path that meets such a surface takes one wavelength between 360 and 830 nm, bends by that
  wavelength's index and carries that wavelength's colour, so a prism shows a continuous spectrum and a diamond its fire; the colours
  average back to the light's own (white light stays white where nothing splits it). The colours are noise until enough wavelengths are
  drawn: give a gem close-up 512 to 2048 `spp`. Draft shows the glass without the split. Light focused through glass onto the set
  (caustics) turns on by itself in Final where it shows; `scene.caustics: false` turns it off. With motion blur on, a Final frame with the
  caustic pass is traced once for each of its sub-frames (16 traces, not one): a scene whose caustic does not show (glass on a dark
  stage, a globe of water seen through) renders a motion-blurred Final video about 16 times faster with `caustics: false`. It works with every camera: perspective,
  orthographic and tilt-shift. A caustic seen through glass shows too: the bright spot a dew drop focuses on the petal under it, seen
  through the drop; a glass's caustic on the table, seen through the glass (a photon map read along the camera's own rays through the
  glass, a pixel wide). The photons start on the glass itself, most where the camera sees the glass big (near and in view), so the
  drops in focus get theirs even beside a meadow of dew far behind. A caustic far out of focus (dew throwing the sun onto the blurred background of a macro shot) is a soft
  blur, not a haze of bright specks. Light a drop focuses on the sunny side of a petal or leaf shows through the sheet to the other
  side (its translucency). An HDRI with a sun in it (a small, very bright patch, as a clear-sky map has) throws its caustics too, as a
  sun light does. Its light adds to a sun light set the same way: the two together are two suns' worth (a clear-sky map at 0.6 sends
  about as much from its sun as a sun light of 3.5). A close-up whose drops or glass catch a sun says `"caustics": true` so the pass, not the probe,
  decides. With caustics on and a lens with an aperture (`fStop`), the sun seen in or through a drop or glass far out of focus (the
  sparkle of backlit dew, a sunlit glass rim behind the subject) is drawn as the soft bokeh disc it is, smooth at the Final's samples, not
  a scatter of specks (a round aperture, no `blades`, no `anamorphic`, a camera that does not move under the shutter; a tilt-shift or
  orthographic camera keeps the specks). Such discs are real light: a Final's `clamp` no longer takes them.
  Glass on a glossy surface (a perfume on polished stone, a lacquered or clear-coated tray, a mirror card, metal): the surface's sharp
  reflection of the glass's lit inside is traced from the camera, and the caustic on its matte part comes from the pass, so the bottle's
  reflection in the stone is clean at 64 samples, with no white specks (a lobe smoother than roughness 0.3 counts as sharp: a clear coat
  or the base's own gloss). A still's `critique` says so where the pass still leaves specks (`critique.caustics.specks`).
  Smooth glass and water (transmission over 0.5, roughness under 0.1) have a bounce budget of their own (24 hits through or off them)
  beside `bounces`, so light caught inside a drop by total internal reflection stays (before, a white floor with dew read up to a third
  darker inside the drops at `bounces` 12). A surface under water or inside glass (a petal under a drop, a stone in a glass of
  water) has its gloss against that water, not air: much less glossy, as a wet petal under a drop is. A translucent leaf or petal under a drop, lit
  from behind, glows through the drop about as brightly as the bare petal beside it (as a backlit petal with dew does), and a drop made by
  the `drops` op (a cap open at its foot, `thinWalled: false`) is water closed by the surface it sits on: through that surface is air.
  What the camera sees through or in clear glass is direct light to `clamp`; light that a drop
  focuses onto the surface under it is a caustic, which `clamp` takes: dew lit by a small bright panel beside the lens (a catch light,
  as macro photographers use) glows inside each drop only with `clamp` off (at `clamp: 6` under half of that glow stays and the drops
  look flat). Leave `clamp` off for dew and glass close-ups.
- Final traces all of this for real. Draft shows glass see-through and bent, tinted by `attenuationColor` over its depth, and no
  caustics. A liquid in its glass, ice in a drink: Draft draws what is held first (a transmissive object whose middle lies inside a
  bigger one's box) and the glass then shows it through its walls (the walls bend the view as sheets), so a perfume shows its amber and
  its level in Draft too; the way the light bends at the liquid's own surface is Final's. What is held is a column, not a lens: it shows
  what stands behind the bottle, tinted, its top and its foot as even as its middle. A glossy plinth, slab or tray a product stands on
  (a solid with a flat top of at least 0.01 m2, roughness or `coatRoughness` under 0.4, a material of its own) mirrors the set on its
  top in Draft, the glass and the liquid on it in their tint, as a glossy floor does. A glTF model's own glass (a file's
  transmissive material) is drawn by the same Draft glass as the scene's (a closed glass ball in a file turns the view over in Draft too).
  Judge glass and liquids in Final (`render-still` with `"mode": "final"`).
- Window glass is `"pane": true`, not `transmission`: thin, flat, clear glass in a frame (`{ "pane": true }`, only `ior` [1.52] to
  set). In Final every ray goes through it unbent, less what its two faces reflect (Fresnel: about 8 % head on, more at a slant): the
  sky's and the sun's light come into the room through it (no caustic specks, no dark room), a room's window portals stay open behind
  it, and it reflects the room faintly over the view. Draft draws it as clear glass. Give it to the `room` op's `glass` part (a 6 mm
  sheet in each frame): `{ "id": "glass", "material": "pane", "graph": [{ "op": "room", ..., "part": "glass" }] }`. A glass object
  (a bottle, a tumbler) stays `transmission`.

#### Cloth (`fabric`)

```json
"materials": {
  "sofa": { "graph": { "preset": "wornFabric", "color": "#b3b0aa" }, "fabric": { "weave": "basket", "threads": 300 } },
  "throw": { "base": "#d8cdb9", "doubleSided": true, "fabric": { "weave": "knit", "threads": 85, "relief": 1.4 } },
  "rug": { "graph": { "preset": "woolRug" }, "fabric": { "weave": "pile", "threads": 420 } }
}
```

- `fabric` gives a surface the threads' relief, the crevices between them and each thread's own shade, at a scale no texture bake can
  hold, and a cloth's response: a soft sheen at grazing angles, a weak specular, fully rough (the material's own `sheen`, `specular`,
  `roughness` win). Without it a sofa reads as grey clay or vinyl and a rug as a printed mat.
- `weave`: `plain` (linen, cotton), `twill` (diagonal: denim, upholstery), `basket` (two by two: woven upholstery), `knit` (V stitches
  in columns: a throw, a jumper), `pile` (tufts: a wool rug, velvet, towelling). `threads` [300] per metre: fine linen 300 to 600,
  upholstery 150 to 300, a chunky knit 60 to 120, a rug's pile 300 to 800. `relief` [1] 0 to 2, `contrast` [0.5] how dark the
  crevices are, `variation` [0.5] how much the yarn's shade varies: a thread's shade drifts along its run a few crossings at a time,
  soft heathered patches of a few threads, and the dye lot and the yarn's twist wander over a hand's width, none of it lined up with
  the weave, so from across a room the cloth reads as an uneven woven texture, not a printed check.
- It follows the mesh's own uv in metres (every op's mesh has it; `uvBox` after ops that rebuild one). It goes over a texture graph
  (whose bake keeps the wear, the grime and the colour) or a plain `base`; seen from afar the cloth keeps the material's colour.
- Final traces the threads at every sample, so they average over a pixel as a camera averages them: no texture, nothing to alias.
  Draft draws the same threads and fades them to their mean where a thread is narrower than half a pixel (no shimmer, no moiré).

#### Glowing surfaces

```json
"materials": {
  "screen": { "base": "#000000", "emission": "#ffffff", "emissionStrength": 3, "maps": { "emission": "/media/…/ui.png" } },
  "bulb": { "base": "#fff3e0", "emission": "#ffd9a0", "emissionStrength": 12 },
  "neon": { "base": "#200810", "emission": "#ff2a6a", "emissionStrength": 8 }
}
```

- `emission` is the colour the surface gives off (black, the default, is none) and `emissionStrength` multiplies it. In Final a glowing
  surface is a real light: it lights what is around it, and the strength sets how much. A monitor in a dark room is about 1 to 2 (a
  night desk scene uses 1.2 for its screen and 2 for glowing mouse pads), a bulb or a neon tube that lights the room 8 to 15 (its bulb
  is 12), a city picture seen through a window at night 0.3 to 0.5. Draft shows it glowing (with `rig.look.bloom`); of what glows, Draft
  lights the set only from the four brightest small parts (under about 20 cm across, no picture: a bulb in a lampshade, so the shade
  glows from inside), out to 15 times their radius (at least 40 cm) and without shadows, and not from a part shut in by an opaque object a few times its
  size (a bulb in a metal lamp head, a pad under keys): give such a lamp a `spot` or `point` light for its Draft light. A light inside its
  own bulb mesh lights only through what of it clears the bulb: a `point` there gives nothing (Draft and Final alike); a `spot` with a
  `radius` is a disc in Final, so it lights the set from the part of its disc outside the bulb and the shade's opening, and Draft does the
  same. Place the lamp in the bulb and give it a radius about the bulb's, or put it just outside the bulb, in the shade's opening.
- `emission` may be a colour temperature, `"2700K"`: a black body's colour at that many kelvin (a filament 2700, a candle flame 1900, a cool LED 4000 to 5000), with luminance 1, so `emissionStrength` still sets how bright.
- `maps.emission` is a picture that glows in its own colours (a screen's content): set `emission` to `#ffffff` so the picture is not
  tinted, and `base` dark so the screen is black where the picture is.
- A small glowing object needs many samples to light a room without speckles; for a lamp, put a `point` light inside the bulb as well
  and keep the bulb's own `emissionStrength` for how it looks.
- A lamp shade that glows from the bulb inside is `translucency` (below) with a `point` light inside, not emission.

### Procedural materials

A material can be a pattern instead of pictures. It is baked into tileable maps (colour, roughness, bump, and metal or glow where the pattern has them) that Draft and Final both read, so it costs nothing at render time:

```json
"materials": {
  "mat": { "procedural": { "pattern": "grid", "scale": 4 } },
  "floor": { "procedural": { "pattern": "wood", "planks": 6, "colors": ["#d6b48e", "#93673f"] }, "uvScale": [3, 3] },
  "steel": { "procedural": { "pattern": "brushed", "direction": "u" } }
}
```

- `pattern`: `noise`, `marble`, `wood`, `grid` (a cutting mat), `tiles`, `bricks`, `checker`, `dots`, `brushed` (metal), `scratches`, `cells` (flagstones; negative `relief` is hammered metal), `terrazzo`, `weave` (fabric), `concrete`, `veins` (a petal's or a leaf's veins, [below](#petals-leaves-flowers-and-stems)). Each looks right with nothing else set.
- Shared: `colors` (a ramp: `'#hex'`, `[at, '#hex']`), `scale` (repeats per UV tile, made whole so it tiles), `roughness` (a number or `[min, max]`), `metalness` (a number, or `[main, accent]` for metal lines), `bump` [1], `seed`, `size` [512] (up to 2048 for close-ups), `emit` (the lines, grout or dots glow).
- Pattern params: `noise { octaves, warp }`, `marble { veins, warp }`, `wood { rings, planks }`, `grid { divisions [5] fine lines per major cell, minor [0.12] their strength from 0 to 1, width [1], groove [0] }` (`scale` is major cells per UV tile), `tiles { grout, stagger, variation }`, `bricks { aspect, mortar }`, `dots { radius, relief (-1 holes) }`, `brushed { direction 'u' | 'v' }`, `scratches { count, length }`, `cells { border, relief }`, `terrazzo { density, chipSize }`, `weave { style 'plain' | 'twill' | 'basket' }`, `concrete { pores, aggregate }`, `veins { kind 'petal' | 'leaf', count, fork, width, wander, vary, contrast, bleed, net, along, blotch, angle, aspect, wear }`.
- `wood` runs along u: the grain and each board are long in u, and `planks` stacks that many boards across v (`rings` growth rings across a board). So lay u along the length of a board, a shelf or a table top; `uvRotation: 90` on the material turns it. `brushed` with `direction: "u"` brushes along u.
- The pattern follows the mesh's UVs: give solids `uvBox` (or `uvPlanar`, `uvCylinder`) after any op that rebuilds them. `uvScale` repeats the tile. `base` multiplies the pattern's colours, so leave it out. A map in `maps` wins over the pattern's own.

### Texture graphs: smart materials with wear and dirt (`graph`)

A material can be a chain of nodes (Houdini Copernicus, Substance) whose outputs are maps: colour, roughness, metalness, height (made into the normal), emission, opacity. The graph is baked once on the GPU into ordinary textures that Draft and Final both read, byte for byte, so it costs nothing at render time. No pictures are downloaded. Start from a preset and set its numbers:

```json
"materials": {
  "floor": { "graph": { "preset": "wornPlanks", "boards": 6.5, "wear": 0.6, "dirt": 0.5, "size": 4096 } },
  "wall": { "graph": { "preset": "paintedPlaster", "color": "#dcd6ca", "dirt": 0.6, "floor": 0, "size": 2048 } },
  "tin": { "graph": { "preset": "rustyMetal", "rust": 0.3, "keys": { "rust": [{ "t": 0, "v": 0.1 }, { "t": 4, "v": 0.8 }] } } }
}
```

Presets (every number keyable through `keys`, as an object's fields are):

- `paintedPlaster` { color ["#e2ddd2"], roughness [0.85], relief [1], trowel [0.6], clouds [0.5], dirt [0.85], dirtHeight [0.35], corners [0.5], dirtColor ["#75685a"], floor [0], seed [0] }: Painted plaster wall: trowel strokes under the paint that catch a grazing light, tone clouds a few percent apart over metres, sand and a roller stipple in the paint, grime in the band above the floor and in the corners and behind furniture.
- `wornPlanks` { colors [["#c6a47e","#ab8862","#8c6b4b","#6c4f36","#4c3624"]], boards [6.5], length [1.4], variation [0.6], gloss [0.34], wear [0.5], dirt [0.7], seam ["#2b1d13"], seed [0] }: Worn plank floor: boards of random length, each its own piece of oak and its own tone, fine seams, a satin finish worn dull where people walk, dirt along walls, in the seams and around furniture legs.
- `wornFabric` { color ["#56677a"], threads [240], style ["twill"], wear [0.5], edgeWidth [0.012], pilling [0.5], dirt [0.35], seed [0] }: Upholstery fabric: a fine real weave with heathered threads; worn on the raised edges and where people sit, the thread tops polished smoother and a little lighter with tiny pills, the weave still showing through; grime in the creases; a sheen like cloth.
- `rustyMetal` { color ["#8e9399"], rust [0.5], cavities [0.7], streaks [0.5], pitting [0.5], rubbed [0.5], colors [["#2a160b","#4b250f","#743914","#97501f","#b87a44"]], roughness [0.42], edgeWidth [0.008], floor [0], seed [0] }: Steel going to rust: dull brushed steel; rust starts where water sits (cavities, inner corners, faces that look up, the foot near the floor) and creeps out from there in broken patches, flaky and pitted, with stains running down below it; edges rubbed back to bright steel in places.
- `scratchedPlastic` { color ["#c8392b"], roughness [0.3], scratches [0.6], edgeWear [0.45], edgeWidth [0.004], dirt [0.3], seed [0] }: Moulded plastic in use: a slight texture in the gloss; hairline scratches, straight, in two crossing strokes, many short and a few long, gathered where it is handled, seen as rougher lines and faint grooves in the gloss rather than in colour; the very edges rubbed duller; grime in the cavities.
- `stainedConcrete` { color ["#9c988f"], stains [0.55], pores [0.6], formwork [0.6], clouds [0.5], dust [0.3], dirt [0.45], floor [0], seed [0] }: Cast concrete: tone clouds over metres and panel to panel, the formwork's joint lines and its tie holes, sand, air pockets of every size, dark water stains running down from the top, dust settled on top faces, grime at the foot and in corners.
- `leather` { color ["#5a311c"], grain [1], wear [0.45], edgeWidth [0.005], roughness [0.48], seed [0] }: Leather: a fine pebbled grain and soft creases, a slight tone drift, burnished lighter and smoother on the edges and where it is handled.
- `lacqueredWood` { colors [["#8f6646","#775238","#5f402b","#47301f","#2f1f14"]], rings [22], width [6], cut ["solid"], axis ["auto"], along ["u"], figure [1.2], wear [0.3], edgeWidth [0.004], gloss [0.05], seed [0] }: Lacquered hardwood furniture: fine grain with pores under a clear glossy coat, cut from a solid log (rings on the end faces, long grain on the sides, the same piece of wood all round), the lacquer rubbed through on the edges.
- `oakBoards` { colors [["#e6d2b0","#d8bf98","#c6a77e","#ae8d63","#8f714c"]], boards [5], length [2.2], variation [0.4], gloss [0.46], wear [0.25], dirt [0.45], seam ["#5a4630"], seed [0] }: Pale oak boards, white-oiled: long boards each its own piece and tone, fine seams, a matte oil finish, a little wear where people walk and dirt along walls and around legs.
- `walnutBoards` { colors [["#7a5238","#64412b","#503221","#3d2518","#2b1a10"]], boards [6], length [1.6], variation [0.55], gloss [0.34], wear [0.2], dirt [0.3], seam ["#21150d"], seed [0] }: Walnut boards: dark, purple-brown and wild-grained, a satin oil finish, fine seams.
- `parquet` { colors [["#d9bc92","#c9a676","#b38c5c","#977148","#795734"]], width [0.07], ratio [5], variation [0.6], gloss [0.3], wear [0.3], dirt [0.4], seam ["#3b2a1a"], seed [0] }: Herringbone parquet: short oak blocks at right angles in a diagonal herringbone, each its own piece and tone, fine seams, a satin lacquer, dirt along walls and around legs.
- `ceramicTiles` { color ["#eeebe4"], grout ["#a19b91"], size [0.15], joint [0.003], variation [0.4], gloss [0.07], dirt [0.5], seed [0] }: Glazed ceramic tiles: square tiles each a shade apart and a touch out of level, a glossy glaze with a slight wave, grout lines darkened with dirt.
- `marble` { color ["#f1efea"], veins ["#8f8b84"], amount [0.6], scale [2.5], polish [0.06], seed [0] }: Polished marble: a white ground with soft grey clouds, a few strong veins that run on unbroken across the slab, wandering, swelling and fading in places, finer veins between them and hairlines; a mirror polish.
- `terrazzo` { base ["#e7e2d8"], chips [["#b6afa3","#5e5a54","#c9744f","#efe9dc","#7c8985","#2f2d2b"]], chipSize [0.014], density [0.55], polish [0.16], seed [0] }: Terrazzo: chips of stone in a pale cement, cut and polished flat; big and small chips, each its own colour.
- `linen` { color ["#ddd5c6"], threads [320], slub [0.6], seed [0] }: Linen: an open plain weave of uneven, slubby threads in a natural tone, each thread a shade apart; matte, with a soft sheen.
- `velvet` { color ["#3c4f5c"], crush [0.5], seed [0] }: Velvet: a dense pile that turns lighter where it lies the other way (crushed patches), deep in the folds, a strong soft sheen at grazing angles.
- `woolRug` { colors [["#ece6da","#3a3631"]], pattern ["diamonds"], size [0.22], line [0.08], pile [1], seed [0], hand [0] }: Wool rug: a dense tufted pile in two colours with a simple motif (diamonds, a hand-drawn diamond lattice, stripes or plain), tufts each a shade apart, soft and matte.
- `paper` { kind ["paper"], color [null], seed [0] }: Paper or cardboard: fibres in the sheet and specks, matte; cardboard brown with its corrugation showing faintly through.
- `rubber` { color ["#272727"], roughness [0.7], dust [0.3], seed [0] }: Rubber: dark, soft and satin-matte, a fine moulded grain, a little dust on the faces that look up.
- `brushedAluminium` { color ["#c9ccd0"], roughness [0.28], brush [1], seed [0] }: Brushed aluminium: fine straight brush lines that stretch the highlights across them, a soft satin sheen.
- `anodisedAluminium` { color ["#30405a"], roughness [0.36], wear [0.3], edgeWidth [0.002], seed [0] }: Anodised aluminium: a coloured metal with a fine bead-blasted satin finish, the colour a little deeper in the hollows and paler on worn edges.
- `chippedPaint` { color ["#3f6e69"], chips [0.5], rust [0.3], edgeWidth [0.006], roughness [0.45], seed [0] }: Painted metal, chipped: a satin paint coat knocked off on the edges and in small flakes, bare steel (rusting a little) in the chips, the coat a step thick at their rims.
- `glazedCeramic` { color ["#d9d3c7"], body ["#b9a58c"], pooling [0.6], speckle [0.35], gloss [0.06], edgeWidth [0.004], seed [0] }: Glazed ceramic (a pot, a mug): a glossy glaze that pools deeper in the hollows and thins to the body on the edges, fine iron specks, a slight wave.
- `frostedGlass` { frost [0.38], pattern ["plain"], band [0.04], tint ["#f4f7f6"], seed [0] }: Frosted glass: clear glass whose surface is etched matte (light passes, the view behind blurs); `stripes` leaves clear bands.
- `asphalt` { color ["#3b3b3b"], aggregate [0.6], cracks [0.3], wear [0.4], seed [0] }: Asphalt: grey stone aggregate set in black binder, the top worn paler where it is driven on, fine cracks.
- `edgeGlow` { color ["#4de3ff"], intensity [7], width [0.006], core [0.3], edges ["convex"], threshold [22], anim ["steady"], speed [1], axis ["x"], run [0.25], base ["#15171b"], roughness [0.32], metalness [0.3] }: Light along the edges of the shape, read from its curvature (not from the picture: the lines do not flicker as it turns), steady, pulsing, or a lit stretch running along an axis: neon edges on 3D text, a product, a wall. The material's emission: it shows in reflections and through glass, and lights the set in Final.
- `fractalNoise` { colors [["#5a1e0c","#d9743a","#f3b48a","#fff4ea"]], scale [14], octaves [5], gain [0.5], type ["plain"], contrast [1.7], brightness [0], evolution [0.35], driftX [0], driftY [0.02], driftZ [0], roughLow [0.6], roughHigh [0.22], metalness [0], emission [0], emissionFrom [0.62], seed [0] }: Fractal noise in the object's own 3D space, alive in time: it boils in place and can flow through the object, and never slides over the surface as the object moves. Colours from a ramp, roughness from the noise, and a glow from its bright end if asked (lava, plasma, smoke on glass, living stone).
- `motionBeam` { axis ["x"], width [0.22], soft [0.6], speed [0.4], position [null], trail [0.6], color1 ["#ffc93f"], color2 ["#2fd07a"], color3 ["#3f7bff"], intensity [6], mode ["glow"], tint [0.4], sheenGlow [0.15], glossRoughness [0.05], base ["#e9e6e1"], roughness [0.35], metalness [0] }: A band of light that travels along an axis of the object (Gradient Motion Beam): three colours head to tail, a fading trail, by speed or keyed by hand; as a glow, or as a sheen (the surface turns glossy under it). A glow lights the set in Final.
- `sweep` { angle [14], width [0.16], core [0.25], color ["#ffe2a4"], intensity [3.5], start [0.3], duration [1.4], gap [0.6], repeat ["loop"], easing ["sine"], progress [null], mode ["glow"], sheenGlow [0.15], glossRoughness [0.05], base ["#e2673f"], roughness [0.5], metalness [0] }: A bright band that sweeps across the object once or again and again (Gradient Sweep): timed by start, duration and gap, or keyed by hand; as a glow, or as a sheen (a glint of gloss crossing a product). A glow lights the set in Final.

- A preset brings plain fields where it needs them (lacquered wood a `coat`, fabric and leather `sheen`); the material's own fields win, and any other material field (`coat`, `sheen`, `transmission` …) works beside a graph. `base`, `roughness` and `metalness` on the material multiply the graph's maps; leave them out.
- Wear and dirt follow the object's shape, so such a graph bakes **per object**, on an atlas of the object's own (a second uv set made for it): edges are found from the mesh itself (a bevelled corner and a sharp one wear alike), cavities and nearby objects by rays against the whole scene as it stands at the scene's time, height and direction in the world. With wear and dirt at 0 a preset bakes once, **tiled** over the mesh's uv like a picture (repeated by `uvScale`), and every object wearing it shares it. A per-object bake never repeats: `"space": "object"` in `graph` asks for one without wear or dirt (a big floor with no visible tiling).
- Patterns are sized for a uv in metres: give solids `uvBox` (or `uvPlanar`, `uvCylinder`) at scale 1; `uvScale` multiplies. Plaster, concrete, rust, plastic and leather read the object's space from three sides when they bake per object, so they need no uv and show no seams; wood, planks and fabric follow the uv's u as the grain or the warp.
- `size` is the bake's width in texels, 256 to 4096. Leave it out and a per-object bake is sized for what the camera sees: a texel about one pixel of a 1080-line picture over nine tenths of what is seen of the object (over the shot, when the camera moves), so a wall far off gets 1024 and the same wall in a close-up 4096; an object the camera never sees gets 512; a tiled bake is 1024. Set `size` for a sharper close-up than that, or for a 4K render. Memory: a map is size² × 4 bytes and a third more for its mipmaps, three maps per bake (colour, roughness and metalness together, normal): 16 MB at 1024, 64 MB at 2048, 256 MB at 4096. The scene's maps share a budget, `textureBudget` in MB (256 when left out, next to `objects` on the Scene): the tiled bakes count in it, and past it the largest automatic per-object bake halves first, one step at a time, never below 512, so a close product shot keeps its 1:1 texels on the hero and gives up a little on the wall behind it (the texgraph product shot: 585 MB at the old sizes, 201 MB now; at 1080p the picture differs by under 1/255 on average, the plaster's finest trowel relief a little softer at 1:1). Sizes set by hand are never changed; raise `textureBudget` (or set `size`) for a 4K still. Objects with the same mesh and graph share one bake when the graph reads nothing of where they stand (no `ao`, `proximity`, `direction` or world `height`). Use sheets (`plane`, `grid`) for floors and walls whose back is never seen: a box spends half its atlas on its hidden faces.
- Bakes are kept by their numbers, like the geometry graph's nodes: changing one material bakes that one again. Wear and dirt are read where things stand when the scene is built (at its current time); objects that move in the shot carry their maps with them. A keyed number bakes again, in place, on every frame where its value changes (tens of milliseconds per object, about 80 at 2048 with wear and dirt); renders wait for it, so keep keyed graphs for things that change on screen.
- The atlas is made once per mesh: up to 2,000 points by xatlas (tens of milliseconds to half a second), past that a quick one with an island per side the faces look to (milliseconds at any size, a few more seams).
- Limits: instanced copies (`copyToPoints`), meshes with shape keys and meshes with translucency by group wear their graph tiled, with edges and cavities read as none; the still's `scene.warnings` says which. A GLB model keeps its own materials unless the object names a `material`, which each of its meshes then wears on an atlas of its own (skinned and morphing meshes tiled).
- `"inspect": true` on a still adds `scene.inspect.textureGraphs`: every bake kept, `{ material, object, space, size, bakeMs, atlasMs, mb }`, and the total `gpuMB`.

Your own graph: `nodes` is a list like a geometry graph's (each `{ "op", "id", ... }`, a node's main input is the node before unless given as `"#id"`), `out` names the maps:

```json
"stone": { "graph": { "size": 2048, "params": { "dark": 0.4 },
  "nodes": [
    { "id": "cells", "op": "voronoi", "scale": 6 },
    { "id": "joint", "op": "math", "a": "#cells.g", "fn": "smoothstep", "low": 0, "high": 0.05 },
    { "id": "tone", "op": "gradientMap", "in": "#cells.b", "colors": ["#6b665e", "#a49d90"] },
    { "id": "edge", "op": "curvature", "width": 0.01 },
    { "id": "worn", "op": "blend", "a": "#tone", "b": "#edge", "mode": "screen", "opacity": 0.4 },
    { "id": "rough", "op": "math", "a": "#joint", "fn": "remap", "low": 0.95, "high": "$dark" }
  ],
  "out": { "base": "#worn", "roughness": "#rough", "metalness": 0, "height": "#joint", "heightScale": 0.003 },
  "keys": { "dark": [{ "t": 0, "v": 0.4 }, { "t": 2, "v": 0.8 }] } } }
```

- `out`: `base`, `roughness`, `metalness`, `height`, `emission`, `opacity`, each `"#id"` (or `"#id.g"` for one channel of a node), a number or a colour; `heightScale` is the relief in metres at height 1 [0.001], `emissionStrength` [1]. A number or colour bakes no map.
- `params` are numbers your nodes use as `"$name"`, and `keys` animate them (as an object's `keys`).
- `coord` on the graph or on a generator: `uv` (default), `triplanar` (object space from three sides, per-object bakes), `world` (world space from three sides: what runs with gravity, stains and drips, keeps running down on a turned object), `atlas`, or `at: "#planks"` to read the coordinates of a planks or tiles node (every board its own piece of wood).
- A node outputs four channels or one; `"#id.r"` … `"#id.a"` picks one. Unknown ops and fields are errors that name the right ones.

Nodes (params with defaults; `scale` is repeats per uv tile, made whole in a tiled bake so it tiles):

- `ao { radius [0.25], power [1] }`: how open the surface is within `radius` metres: 1 open, toward 0 in corners, under and between things (dirt collects there).
- `beam { axis [[1,0,0]], width [0.18], soft [0.6], speed [0.5], position, trail [0.5], c1 ["#ffc93f"], c2 ["#2fd07a"], c3 ["#3f7bff"] }`: a band of light that travels along an axis of the object (Gradient Motion Beam): rgb its colours (head, middle, tail), a how much; by `speed`, or keyed by hand with `position`.
- `blend { a, b, mask, mode ["mix"], opacity [1] }`: b over a by mask (or opacity): mix, multiply, add, screen, overlay, subtract, max, min, difference.
- `blur { in, radius [0.01] }`: a soft blur, `radius` as a share of the tile (wraps at the seams when tiled).
- `constant { value [1], color }`: one value or colour everywhere.
- `curvature { width [0.006], mode ["convex"], threshold [20] }`: edges of the object: 1 on a convex edge or corner, fading over `width` metres (worn paint, polished corners); concave for inner corners.
- `curve { in, points [[[0,0],[1,1]]] }`: a curve through up to 8 points [x, y], smooth between them.
- `direction { axis [[0,1,0]], from [0.3], to [1] }`: how much the surface faces `axis` (world): 1 facing it, 0 at `from` and below (dust on top: axis up, from 0.5).
- `edgeGlow { color ["#4de3ff"], width [0.006], core [0.3], threshold [22], edges ["convex"], anim ["steady"], speed [1], axis ["x"], run [0.25] }`: light along the edges of the shape (its curvature, not the picture's edges: steady as the object turns): rgb the glow's colour, a how much; steady, pulsing, or a lit stretch that runs along an axis.
- `fbm { scale [[4,4]], seed [0], coord ["uv"], octaves [6], gain [0.5], type ["plain"], warp [0], contrast [1] }`: fractal gradient noise, 0..1 around 0.5: plaster, stone, stains, any soft mottling.
- `fractal3d { scale [9], octaves [5], gain [0.5], type ["plain"], contrast [1.4], brightness [0], evolution [0.35], drift [[0,0,0]], seed [0] }`: fractal noise in the object's own 3D space, alive in time: it boils in place (`evolution`, time is its fourth axis) and can flow through the object (`drift`), never sliding over the surface as the object moves; 0..1 around 0.5.
- `gradient { kind ["u"], coord ["uv"] }`: a ramp across the tile: linear along u or v, radial or box from the centre (not periodic).
- `gradientMap { in, colors [["#000000","#ffffff"]] }`: colours from a value through a ramp (the value is the input's r).
- `height { from [0], to [0.3], space ["world"] }`: height in the world: 1 at `from` metres, 0 at `to` (a band of dirt above the floor: from 0, to 0.3).
- `heightToAO { in, radius [0.01], strength [4] }`: cavities of a height map: 1 open, darker where the height sits below its surroundings.
- `herringbone { scale [[8,8]], seed [0], coord ["uv"], ratio [5], gap [0.03], bevel [0.05] }`: herringbone parquet: boards at right angles, the pattern turned 45 degrees. r = height (1 on a board, down to 0 in the seam), g = a random per board, b and a = coordinates on the board (along it in board widths, across 0..1): feed them to `at` of wood so every board is its own piece. Per-object bakes (it does not wrap).
- `image { src [""], scale [[1,1]], coord ["uv"] }`: a picture (a media url, `tex:<name>` or a data: url): its colour in linear light, alpha in a, repeated `scale` times per uv tile.
- `levels { in, inLow [0], inHigh [1], gamma [1], outLow [0], outHigh [1] }`: levels: inLow..inHigh to outLow..outHigh with a gamma.
- `math { a, b, fn ["add"], value [1], low [0], high [1] }`: arithmetic in `fn` on a and b (b may be the number `value`): add, subtract, multiply, divide, min, max, power, invert (1 - a), abs, clamp (low..high), remap (0..1 to low..high), step (1 where a >= b), smoothstep (low..high; high below low falls instead of rising), mix (a to b by `value`).
- `pattern { name ["noise"], output ["color"], scale [[1,1]], coord ["uv"] }`: one of the 14 procedural patterns (wood, marble, tiles, bricks, weave, concrete ...), baked on the CPU as the materials' `procedural` and read here: `output` picks colour (linear rgb), height, roughness or the accent mask.
- `planks { count [6], length [0.5], lengthJitter [0.6], gap [0.012], bevel [0.06], seed [0], coord ["uv"] }`: boards: r = height (1 on a board, down to 0 in the seam), g = a random per board, b and a = the coordinates on the board (along it in board widths, across it 0..1); feed b, a to `at` of wood or noise so every board is its own piece.
- `position {  }`: the object-space position (metres) in rgb, for patterns of your own through math.
- `proximity { radius [0.2], power [1] }`: how close other objects are: 1 touching, 0 beyond `radius` metres (dirt on a floor around furniture legs).
- `scratches { scale [[6,6]], seed [0], coord ["uv"], count [3], length [0.8], width [0.004], angle [20], directions [1], turn [70], spread [10], curve [0] }`: thin scratches as grooves: the depth of the deepest scratch here, 0 elsewhere; straight, along a few preferred directions, many short and a few long, each its own depth. Feed roughness and height with it, colour barely.
- `shape { scale [[1,1]], seed [0], coord ["uv"], kind ["circle"], size [[0.35,0.35]], softness [0.01], thickness [0.05], jitter [0] }`: a shape by its signed distance, repeated per cell: 1 inside, 0 outside, soft at `softness`.
- `slopeBlur { in, length [0.08], dir [[0,1]] }`: smears `in` downward along a direction in uv (drips, streaks); tiled bakes only.
- `sweep { angle [14], width [0.16], core [0.25], color ["#ffe2a4"], start [0.3], duration [1.4], gap [0.6], loop [true], easing ["sine"], progress }`: a bright band that sweeps across the object once or again and again (Gradient Sweep): rgb its light (core toward white), a the band (for a sheen: glossy under it); timed, or keyed by hand with `progress`.
- `tileRandom { in, min [0], max [1] }`: a value per board or tile, from the g of planks or tiles, between `min` and `max`.
- `tiles { count [[4,4]], stagger [0], gap [0.04], bevel [0.05], seed [0], coord ["uv"], offset [[0,0]] }`: tiles or bricks: r = height (1 on a tile, 0 in the joint), g = a random per tile, b and a = coordinates on the tile 0..1.
- `voronoi { scale [[4,4]], seed [0], coord ["uv"], jitter [0.9] }`: cells: r = distance to the cell centre, g = distance to the nearest border (crisp edges), b = a random per cell, a = the second distance.
- `warp { in, by, amount [0.02] }`: reads `in` displaced by the r and g of `by` (0.5 = no move), `amount` of a tile; tiled bakes only.
- `weave { scale [[48,48]], seed [0], coord ["uv"], style ["plain"], gap [0.12], fuzz [0.5] }`: woven threads: r = height of the thread on top, g = which thread is on top (0 warp, 1 weft), b = fibre fuzz, a = a random per thread.
- `wood { scale [[1,1]], seed [0], coord ["uv"], rings [22], figure [1], grain [0.6], pores [0.5], along ["u"], solid [false], axis ["auto"] }`: wood grain: r = ring value (0 light earlywood, 1 dark latewood), g = fine streaks along the grain (0..1 around 0.5), b = open pores, a = figure; grain runs along u. Read it on boards with `at` (every board its own piece), or on an object by its uv.

### Animated materials: edge glow, live noise, beam, sweep (graph presets)

Four texture-graph presets are alive in time: the material moves on the object as the shot plays. They are materials, not screen
effects: they lie on the object in its own space (the pattern turns and moves with it, it never slides over the surface), they show in
reflections and through glass, and in Final their glow lights the set (a glowing object is sampled as a light). They work on any mesh
object: 3D text (`text`), walls and panels, products, imported meshes. Each is baked on the GPU into the object's own maps on every
frame its numbers change, and Draft and Final read the same maps.

- `edgeGlow`: light along the edges of the shape, read from its curvature (dihedral angles, not the picture's edges: the lines do not
  flicker as the object turns), `steady`, `pulse` or a lit stretch that `run`s along `axis`; `edges` convex, concave or both. A bevel's
  small steps add up to the corner they round, so a bevelled letter glows like a sharp one; smooth curved surfaces stay dark below
  `threshold` degrees.
- `fractalNoise`: fractal noise in the object's 3D space: `evolution` makes it boil in place (time is its fourth axis), `driftX/Y/Z` let it
  flow through the object (metres a second, in the object's own space); colours from `colors`, roughness from `roughLow` to
  `roughHigh`; `emission` above 0 makes its bright end glow (lava, plasma).
- `motionBeam`: a band that travels along the object's `axis` (Gradient Motion Beam): `color1` head, `color2`, `color3` tail, a fading
  `trail`, `speed` passes a second, or keyed by hand with `position` (0 at the start of the object, 1 at its end). `tint` colours the
  surface under it.
- `sweep`: a band sweeping across the object at `angle` (degrees in the object's own x-y plane), timed by `start`, `duration`, `gap` and
  `repeat` (loop or once) with an `easing`, or keyed by hand with `progress` (0 before the object, 1 past it).
- `motionBeam` and `sweep` take `mode`: `glow` (the band emits) or `sheen` (the surface turns glossy under the band, `glossRoughness`, and
  the band still glows by `sheenGlow` of `intensity`: a glint of light crossing a product).
- Every number keys through the graph's `keys`, as an object's fields do. The glow's strength (`intensity`, or `emission` for the noise)
  is the material's emission strength: keying it bakes nothing. Colours do not interpolate between keys (they switch at each key).
- `hold` (seconds) keeps the material at that moment, keys included, while the shot runs on: an object that turns under a still pattern.
- In a video project the Scene item can key them as Rig tracks too: `propertyKeyframes["sc:g~<material>:<param>"]` (positions in % of
  the clip, as every Rig track); the world takes the value in place and bakes again.
- The surface under the glow is the preset's `base`, `roughness` and `metalness` (the noise's colours are its own base); any other
  material field (`coat`, `sheen` …) works beside it, and a `base` on the material itself wins over the preset's.
- The library has ready ones: `neonEdges`, `neonEdgesRun`, `neonEdgesPulse`, `lavaNoise`, `plasmaNoise`, `livingStone`, `beamGlow`,
  `beamSheen`, `sweepGlow`, `sweepGlint` (`{ "preset": "neonEdgesRun" }` on a material; its `graph` fields go over the preset's).

A worked example: neon letters with a lit stretch running across them and a glow that fades up, a wall panel with a beam, and a product
with a gloss glint that crosses it twice. The floor is glossy, so all three show in it, and the glass pane in front of the word shows them
through it.

Film it with the Camera layer at `[0.03, 0.22, 0.95]` looking at `[0, 0.12, 0]`, fov 34 (the helper's `pose`).

```json
{
  "env": { "hdri": "studio", "intensity": 0.15, "background": "#0b0c0f" },
  "lights": [{ "id": "key", "type": "sun", "dir": [-0.5, 0.75, 0.6], "intensity": 1.2 }],
  "materials": {
    "neon": { "graph": { "preset": "edgeGlow", "color": "#4de3ff", "width": 0.004, "anim": "run", "speed": 0.5, "axis": "x", "run": 0.35,
      "keys": { "intensity": [{ "t": 0, "v": 0 }, { "t": 1, "v": 8 }] } } },
    "panel": { "graph": { "preset": "motionBeam", "axis": "x", "width": 0.22, "speed": 0.4, "intensity": 6, "tint": 0.4 }, "coat": 0.3 },
    "bottle": { "graph": { "preset": "sweep", "mode": "sheen", "angle": 62, "start": 0.3, "duration": 1, "gap": 0.5, "intensity": 4, "sheenGlow": 0.4, "base": "#c8392b", "roughness": 0.5 }, "coat": 0.3 },
    "floor": { "base": "#0e0f12", "roughness": 0.1, "coat": 0.6 },
    "glass": { "transmission": 1, "roughness": 0.02, "ior": 1.5, "thickness": 0.006 }
  },
  "objects": [
    { "id": "floor", "material": "floor", "graph": [{ "op": "plane", "size": [10, 10] }] },
    { "id": "word", "material": "neon", "at": [0, 0.02, 0.1], "graph": [{ "op": "text", "text": "GLOW", "size": 0.1, "depth": 0.04, "bevel": 0.004 }, { "op": "smooth", "angle": 35 }],
      "keys": { "rot": [{ "t": 0, "v": [0, -25, 0], "ease": "linear" }, { "t": 4, "v": [0, 25, 0] }] } },
    { "id": "pane", "material": "glass", "at": [0.14, 0.09, 0.2], "rot": [0, -22, 0], "graph": [{ "op": "box", "size": [0.17, 0.2, 0.006] }] },
    { "id": "wall", "material": "panel", "at": [0, 0.22, -0.35], "graph": [{ "op": "box", "size": [0.9, 0.42, 0.03], "bevel": 0.004 }] },
    { "id": "product", "material": "bottle", "at": [-0.23, 0, 0.12], "graph": [{ "op": "lathe", "profile": [[0, 0], [0.046, 0], [0.052, 0.006], [0.052, 0.15], [0.03, 0.18], [0.017, 0.196], [0, 0.196]], "segments": 96 }, { "op": "smooth", "angle": 40 }] }
  ]
}
```

- Cost: an object bake on the object's own atlas (as wear and dirt), sized for what the camera sees but at most 1024 texels unless
  `size` asks for more (a 4K close-up: `"size": 2048`); the surface it reads is made once and kept while the material plays, so a frame
  bakes only the material's own passes, and only on frames where its numbers change (a steady edge glow, a still noise or a beam at
  speed 0 bake once). Final copies only the changed maps into its atlas. A scene without these presets runs none of it.
  `"inspect": true` on a still lists each bake with `animated`, `refreshMs` (the last frame's bake) and `surfaceMb` (what it keeps).
- Draft shows them on the object and through glass; in a glossy floor Draft shows what its reflections show of the scene, Final shows
  them traced. A glow lights the set in Final only (Draft's lights are the scene's lights).
- On a GLB model, name the material on the object (`{ "id": "shoe", "model": "...", "material": "neon" }`): every mesh of the file
  then wears it, baked on each mesh's own atlas (a model with no `material` keeps the file's own materials).
- Limits: instanced copies (`copyToPoints`), meshes with shape keys and skinned or morphing model meshes wear the graph tiled (over the
  uv tile, no object space); the still's `scene.warnings` says which.

### Light through a sheet, light into a body: `translucency` and `subsurface`

```json
"materials": {
  "shade": { "base": "#efe3cc", "roughness": 0.9, "translucency": 0.7, "doubleSided": true },
  "wax": { "base": "#f2e7d3", "roughness": 0.35, "subsurface": 1, "subsurfaceRadius": [1, 0.85, 0.6], "subsurfaceScale": 0.03 }
}
```

- `translucency` (0 to 1) is for thin sheets: curtains, lampshades, paper, leaves. That share of the diffuse colour lets light through to the other side, in `translucencyColor` (default: `base`, with its map). Make the sheet `doubleSided`. A `point` light inside a translucent shade lights the shade and, in Final, the room through it; sun behind a curtain throws its colour on the floor. A sheet stops a light's beam and glows with it: it throws a shadow in Draft and Final alike, and another sheet in that shadow is lit by its glow, so light through two petals is a deeper colour, not black.
- `subsurface` (0 to 1) is for things light goes into: skin, wax, soap, marble, milk, jade. It is Blender's Subsurface Weight: `subsurfaceRadius` `[r, g, b]` is how far each colour travels, in metres before `subsurfaceScale` (defaults `[1, 0.2, 0.1]` and 0.05, as Blender), `subsurfaceAnisotropy` -0.9 to 0.9. The colour is `base`. Use a closed mesh; the radius must be small against the object (a few millimetres for a 10 cm thing) or it turns to jelly. Starting points: skin `[1, 0.35, 0.2]` × 0.02, wax `[1, 0.85, 0.6]` × 0.03, soap `[0.8, 1, 0.9]` × 0.012, marble `[1, 1, 1]` × 0.008.
- Final traces both for real (a random walk inside the mesh for subsurface). Draft approximates: light wraps past the shadow edge for subsurface, and a sheet glows from behind and casts a lighter shadow for translucency. A material has one or the other; with both, `subsurface` wins. A `.blend` import carries Principled Subsurface, and a Translucent BSDF mixed into a Principled at a set amount becomes `translucency`.

### Thin film, real metals, brushed metal, round edges: `iridescence`, `metal`, `anisotropy`, `roundEdges`

```json
"materials": {
  "bubble": { "base": "#ffffff", "roughness": 0, "transmission": 1, "ior": 1, "iridescence": 1, "iridescenceThickness": 380 },
  "oil": { "base": "#0e0e10", "roughness": 0.08, "iridescence": 1, "iridescenceIOR": 1.45, "iridescenceThickness": [250, 750] },
  "cap": { "metal": "gold", "roughness": 0.18 },
  "brushed": { "metal": "aluminium", "roughness": 0.18, "anisotropy": 0.8 },
  "dial": { "metal": "aluminium", "roughness": 0.2, "anisotropy": 0.85, "brush": "spun" },
  "part": { "base": "#2a4f8a", "roughness": 0.25, "roundEdges": 0.004 }
}
```

- `iridescence` (0 to 1) is a thin film on the surface: soap, oil, coated glass, heat-tinted or coated metal. Its colour turns with the angle and with `iridescenceThickness` in nanometres (default 400; 200 to 800 shows colours, thicker turns pastel). `iridescenceIOR` is the film's own (default 1.33 soap water, 1.45 oil, 1.4 a lens coating). A pair `[min, max]` lays a soft swirl of thicknesses over the surface, so the colours run in bands (needs uvs). A soap bubble is `transmission: 1, ior: 1, roughness: 0, iridescence: 1` (both sides of a film are drawn by themselves, no `doubleSided` needed; it casts no shadow); a coated bottle is glass with `iridescence` 0.5 to 1. The rim of a bubble turns green, gold and magenta as in Cycles. In the editor, glass and bubbles in front of an empty, see-through background keep their reflections and rims when the layer is composited, in the preview, Draft and Final: what they reflect goes over the layers below as light.
- `metal` makes a real metal from its complex index of refraction: `gold`, `silver`, `copper`, `aluminium`, `chrome`, `iron`, `titanium`, or `{ "n": [r, g, b], "k": [r, g, b] }` for any other (Blender's Metallic BSDF Physical Conductor numbers work as they are). It sets `metalness` 1 and the colour, so leave `base` out; `roughness`, `coat`, `iridescence` and maps work as usual. Its edges keep the metal's own colour, which a `base` colour on `metalness: 1` cannot.
- `anisotropy` (0 to 1) is brushed metal: highlights stretch across the brush lines. `brush: "linear"` (default) runs the lines along `brushAxis` in the object's own space (default `[1, 0, 0]`); `brush: "spun"` lays them in circles around `brushAxis` (default `[0, 1, 0]`), the turned look of a watch dial, a pan base or a speaker cap, whose highlight is a streak through the middle. `anisotropyRotation` turns the lines (degrees). 0.6 to 0.9 with `roughness` 0.15 to 0.3 reads as brushed.
- `roundEdges` (metres) rounds a mesh's sharp edges at render time, in the shading only: CAD parts, boxes and extrusions catch a thin highlight along every edge as a product shot's bevelled ones do. 0.002 to 0.01 for objects of 10 to 30 cm; keep it under a third of the thinnest wall. Draft and Final both round them (Draft from the mesh's sharp edges worked out once when the scene builds, up to 200 000 triangles a mesh; past that Draft shows the edges sharp and `scene.warnings` says so), and only edges of the same object round; for a silhouette that is round too, model it with the `bevel` op. It costs Final time where such objects fill the frame (+50 to 70 % on a close product shot of such parts), so give it to the hero objects, not the room.
- A `.blend` import carries Principled Thin Film (thickness and IOR) and a Metallic BSDF set to Physical Conductor (its n and k, as `metal`).

### Car paint, dust and toon: `flakes`, `coatBump`, `dust`, `toon`

```json
"materials": {
  "carRed": { "base": "#8c0d10", "coat": 1, "coatRoughness": 0.03, "flakes": { "amount": 0.7, "size": 0.15 }, "coatBump": 0.3 },
  "dustyCrate": { "base": "#262a30", "roughness": 0.35, "dust": { "amount": 0.8 } },
  "cel": { "base": "#ff7a1a", "toon": { "steps": 3, "outlineWidth": 3 } }
}
```

- Car paint is three layers: the paint (`base`), metallic `flakes` in it, and a clear coat (`coat`, `coatRoughness`) with its own relief
  (`coatBump`, orange peel). `flakes`: a number 0 to 1 (how many and how bright) or `{ amount [0.6], size [0.15] mm, spread [18]
  degrees each flake's tilt, seed }`; each flake glints on its own where the light catches it, so a highlight sparkles and a sparkle runs
  across the body. Unset `metalness` becomes 0.35 + 0.6 × amount and `roughness` 0.32. `coatBump`: a number 0 to 1 or `{ amount [0.4],
  scale [4] mm, seed }`: the coat's reflection wobbles softly while the paint under it keeps its own (0.2 to 0.4 a factory finish, 0.7 a
  respray); it needs `coat`. Both follow the mesh's uv in metres (`uvBox` on solids) and are two small maps made on the spot (no download).
  Final traces every flake, so the glitter averages over a pixel as a camera's does; Draft draws the same flakes (close up each flake,
  further off the grain of many in a pixel, their spread widening the sheen), so a paint's glitter and highlight read in Draft as in
  Final. `flakes` replaces `maps.normal`.
- `dust` settles on what faces up: a number 0 to 1 or `{ amount [0.5], color ["#c9c2b4"], up [0.5] (1 lets it reach down the sides),
  seed }`: lighter, matte, in soft patches, thinner on steeper faces, following each object's shape. It makes the material a per-object
  texture graph of its own `base`, `roughness` and `metalness` (a material with a `graph` keeps its preset's own dirt and dust), so it
  costs a bake at build and nothing per frame. A `coat` stays glossy over it: lower `coat` on a dusty car.
- `toon` is cel shading for motion design: `true` or `{ steps [3] bands of light, shade [0.35] the darkest band as a share of the colour,
  outline [true], outlineWidth [2] px, outlineColor ["#000000"] }`. The surface takes its light in hard bands of `base` and an outline
  follows its silhouette and creases at a constant width on screen. Draft and Final draw it the same (cel shading is the raster's; in
  Final the object still casts its traced shadow and bounces its colour onto the set). A light's shadow falls on it only on the side
  facing that light, read 1 cm off its surface (its bands already draw where it turns from the light, down to `shade` on the far side;
  its own shadow there laid stair-stepped dashes along the bands), and no ambient occlusion patches its bands. Other surface fields do not apply to it.

### The material library: `preset`

Over a hundred ready materials, made here (no download): `{ "preset": "<name>" }` on a material. Each is a set of the material's
own fields (metals by their real n and k, glass and gems with dispersion, liquids with their priority, car paints with flakes and orange
peel, the texture graphs' surfaces with their wear), and the material's own fields go over it: `{ "preset": "carPaintRed", "base": "#1e4d2b" }`
is a green car paint, `{ "preset": "marbleWhite", "graph": { "preset": "marble", "veins": "#6a5a4a" } }` a marble of other veins.
Solids that wear a pattern, a texture graph, flakes or cloth want a uv (`uvBox` after the ops). Patterns are at their real size (a marble's
veins some 40 cm apart, planks 15 cm wide): on a small object a pattern shows a piece of itself; its graph preset's own size fields change that (`{ "preset": "marbleWhite",
"graph": { "preset": "marble", "scale": 12 } }`: veins 12 a metre).
Coloured glass, stones and liquids take their colour by depth (`attenuationDistance`), set for the size they are used at (a bottle's wall
a few millimetres thick, a stone a centimetre across, a glass of wine): on a big solid object they go dark as the real thing would, so
raise `attenuationDistance` with the object (`{ "preset": "ruby", "attenuationDistance": 0.05 }` for a 10 cm ruby ornament).

- Metals: `goldPolished`, `goldSatin`, `goldBrushed`, `silverPolished`, `silverSatin`, `copperPolished`, `copperSatin`, `copperRough`, `aluminiumPolished`, `aluminiumSatin`, `aluminiumBrushed`, `aluminiumAnodisedBlue`, `aluminiumAnodisedRed`, `aluminiumAnodisedBlack`, `chromePolished`, `chromeSatin`, `ironRough`, `ironCast`, `steelBrushed`, `steelSpun`, `steelRusty`, `steelPaintedChipped`, `titaniumSatin`, `titaniumBrushed`, `brassPolished`, `bronzeSatin`, `hammeredMetal`.
- Plastics and rubber: `plasticGlossyWhite`, `plasticGlossyBlack`, `plasticGlossyRed`, `plasticGlossyYellow`, `plasticGlossyBlue`, `plasticMatteWhite`, `plasticMatteGrey`, `plasticMatteBlack`, `plasticSoftTouch`, `plasticScratched`, `plasticTranslucent`, `acrylicClear`, `acrylicFrosted`, `rubberBlack`, `rubberRed`.
- Glass and gems: `glassClear`, `glassFrosted`, `glassGreen`, `glassAmber`, `glassBlue`, `crystal`, `diamond`, `sapphire`, `ruby`, `emerald`, `ice`.
- Liquids: `water`, `perfume`, `whisky`, `redWine`, `oliveOil`, `soapBubble`.
- Paints and car paints: `carPaintRed`, `carPaintBlue`, `carPaintSilver`, `carPaintBlack`, `carPaintWhitePearl`, `carPaintGreen`, `carPaintOrange`, `carPaintMatteGrey`, `carPaintDusty`, `wallPaintMatte`, `wallPaintSatin`, `lacquerBlack`, `enamelWhite`.
- Wood: `oakBoards`, `walnutBoards`, `parquetHerringbone`, `plankFloorWorn`, `lacqueredWood`, `woodProcedural`.
- Stone, concrete, brick: `marbleWhite`, `marbleBlack`, `marbleGreen`, `terrazzo`, `concreteCast`, `concreteProcedural`, `granite`, `slate`, `bricks`, `asphalt`, `plaster`.
- Ceramic: `ceramicTiles`, `ceramicGlazed`, `porcelain`.
- Cloth, leather, paper: `linen`, `velvetBlue`, `velvetRed`, `upholsteryWorn`, `denim`, `knitWool`, `woolRug`, `leatherBrown`, `leatherBlack`, `paper`, `cardboard`.
- Skin, wax and other bodies light goes into: `skin`, `wax`, `soap`, `jade`, `leaf`.
- Glows: `neonPink`, `neonBlue`, `ledWhite`, `tungstenBulb`, `candleFlame`, `screenOff`.
- Toon: `toonOrange`, `toonTeal`, `toonViolet`, `toonWhite`.
- Animated (alive in time, see [animated materials](#animated-materials-edge-glow-live-noise-beam-sweep-graph-presets)): `neonEdges`, `neonEdgesRun`, `neonEdgesPulse`, `lavaNoise`, `plasmaNoise`, `livingStone`, `beamGlow`, `beamSheen`, `sweepGlow`, `sweepGlint`.
- Dusty: `dustyBlackPlastic`, `dustyChrome`, `dustyShelf`.

### Real relief from a height: `displacement`

```json
"materials": {
  "wall": { "base": "#a65a3f", "roughness": 0.85, "displacement": { "height": "/media/…/bricks_height.png", "scale": 0.02, "midlevel": 0, "detail": 0.004 } },
  "path": { "procedural": { "pattern": "cells", "relief": 1 }, "displacement": { "height": "pattern", "scale": 0.015 } }
}
```

- The mesh is cut into smaller triangles and every point moves along its normal by (height - `midlevel`) × `scale` metres, as Blender's
  Displacement node with Displacement Only (and its Displace modifier) does: real geometry, so the silhouette, the shadows and the
  contact with the floor are the relief's, the same in Draft and Final.
- `height`: a picture (a media URL or `tex:<name>`), read raw (white 1, black 0) over the mesh's uv with the material's `uvScale`,
  `uvOffset` and `uvRotation`, as its maps are; or `"pattern"`, the material's own `procedural` pattern's relief. `scale` [0.01] metres at
  height 1; `midlevel` [0.5] the height that stays put (0 pushes out only, as for bricks that stand out of their mortar).
- `detail` (metres) is the longest edge the mesh is cut down to [a 200th of its size]: a few millimetres for relief you look at closely.
  Each halving makes 4 times the triangles; `maxTriangles` [400 000] caps a mesh (the detail then stops short and `scene.warnings`
  says so), and a scene's displaced meshes together stay under 1 600 000. Points at one place (a uv seam, a box's edge) move together, so
  the surface does not tear; a hard edge stays hard.
- The mesh needs uvs (every op's mesh has them; `uvBox` after ops that rebuild one). A normal map still adds its finer detail on top.
  Cheaper relief that does not change the silhouette is a texture graph's `height` (a normal map).

### A surface that comes and goes: `reveal`

A material with `"reveal": { "map": "/media/…/reveal.png", "fps": 24 }` is there only between two frames, each texel its own: ink drawn on over a shot and wiped away later. A `.blend` import writes it from keyed material values (blender.md (GreenLight Dash only)). The map lies over the uv like the material's other maps (`uvScale`, `uvOffset`). Each texel's rgb holds two frames counted from the scene's time 0 at `fps`, twelve bits each: it comes on at `r * 16 + (g >> 4)` and goes at `(g & 15) * 256 + b`, and 4095 is never. Outside its frames a texel is not there at all: not drawn, no shadow, no depth, and no ray hits it in Final. When an imported surface also switches between two looks, each look is a material of its own (`<name> · early`, then `<name>`) on twin objects sharing one mesh, and their `reveal` maps take turns.

### Objects and graphs (Blender outside, Houdini inside)

`objects` is a tree (`parent`). Each object's geometry is its `graph`: an array of nodes. A node is `{ "op": "...", ...params }`
and may have an `"id"`. By default a node's input is the node before it, which is why a plain chain reads like a modifier
stack. `"in"` overrides that:

- `"in": "#a"` or `"in": ["#a", "#b"]`: other nodes of this graph, by id.
- `"in": "@desk"`: the output of another object, in that object's local space (Houdini's Object Merge).

The graph's output is its last node. A graph may be a single op (a source) or many.

Results are cached per node by a hash of `op + params + inputs`, so changing one parameter recomputes that node and the
ones after it, and nothing before. Ops never change their inputs and give the same result for the same `seed`.

`"bypass": true` on a node switches it off, and what fed it goes straight through. A graph the user edits in the editor is written back to these same fields, with every node given an `id` and an explicit `in`.

## Motion design: one clock per move

Motion that reads as designed is not many keyed tracks that happen to overlap. It is the way a Blender motion designer rigs a move with
drivers: **one clock per move**, a value u from 0 to 1 that every channel of the move reads, and **each channel through its own remap**
of u, whose segments are the app's eases. They start, accelerate, glide and land together because they read one clock; each has its own
punch because each has its own curve. The Scene has the same tools: `scene.clocks`, `drive` on any keyable field, the editor's ƒx on
keys (`fx`), a follow path (`path`), and layers that ride an object (`parent`, `worldParent`). None of them adds a key per frame: a
whole move is two clock keys and a few remap points per channel.

### Clocks and drives

```json
"clocks": { "move1": { "keys": [{ "t": 1.533, "v": 0, "ease": "smoothGlide" }, { "t": 3.4, "v": 1 }], "filter": { "glide": "soft" } } }
```

- `scene.clocks.<name>`: `keys` like any track (`t` seconds, `v` a number, any `ease`), then `filter`, any ƒx of the editor run on the keyed
  value ([below](#the-editors-ƒx-on-scene-keys-fx)). `{ "glide": "soft" }` is the editor's Glide ƒx (Soft): the move lands softly and creeps
  on past its last key, never overshooting and never coming back. Two keys eased `smoothGlide` through Glide Soft is the owner's move:
  fast out, a long glide, a fast collapse, a soft landing.
- `drive` on an object, the camera or a `layers2d` card, beside `keys`: `{ "<field>": { "clock": "move1", "map": [[u0, v0, ease], [u1, v1, ease], …] } }`.
  The field is the clock's value through `map`: below the first `u` it holds `v0`, above the last the last `v`, and between two points it
  moves with the first point's `ease` (any name or `[x1, y1, x2, y2]` a key takes; `linear` follows u exactly; left out, `inOut`).
  `v` has the field's shape: a number, or `[x, y, z]` for `at`, `rot`, `target`. Without `map` the field is u itself.
- Drivable fields are the keyable ones: an object's `at`, `rot`, `scale`, `shape:<name>`, its path's `along` and `bank`; the camera's `at`,
  `target`, `fov`, `lens`, `focus`, `fStop`, `orthoHeight`, `shift`, `tilt`, `iso`, `shutter`; a card's `at` and `rot`. Not `visible`.
- A list of terms combines them, and so do keys and a drive on the same field: **`scale` multiplies, every other field adds**. A logo that
  grows in on move 1 and shrinks out on move 2 is `"scale": [{ "clock": "move1", "map": [[0.8, 0, "appleOut"], [0.97, 1]] }, { "clock": "move2", "map": [[0, 1, "natural"], [0.24, 0]] }]`;
  a spin keyed for an entry plus a spin driven by the move is `keys.rot` and `drive.rot` together.
- A scale of 0 hides a thing completely (it stands at a millionth of its size); use `visible` keys to switch a thing off between moves.
- Times: with the clock above (keys 56 frames apart at 30 fps, Glide Soft) u reaches 0.05 three frames after its first key, 0.24 at
  11, 0.30 at 15, 0.45 at 37, 0.58 at 50, 0.80 at 57, 0.86 at 59, 0.97 at 77 and 0.99 at 94; the last key's own time (56) is u 0.77.
  Keys 30 frames apart: 0.24 at 8, 0.30 at 11, 0.58 at 29, 0.86 at 35, 0.97 at 56. Put each event at the u where it should happen.

### Expressions (a driver's scripted expression)

A term may be an expression instead of one remap: `{ "expr": "…", "vars": { "<name>": { "clock", "map" } | number } }`, in the editor's ƒx
language (the Custom ƒx's: `+ - * / ^`, `sin`, `cos`, `min`, `max`, `clamp`, `lerp`, `PI`, lists `[x, y, z]`), over its variables (each
a clock through its own remap) and `time` (seconds on the Scene's clock). It gives a number, or `[x, y, z]` for a vector field. Use it for
what one remap cannot say: a product or a quotient of two curves, a swirl, a slow push under a zoom.

```json
"at": { "expr": "[r * cos(a + 2.4), 0.8 * r * sin(a + 2.4), -0.6 * r * sin(a + 3.4)]",
        "vars": { "r": { "clock": "move1", "map": [[0.8, 0.06, "appleOut"], [0.97, 0]] },
                  "a": { "clock": "move1", "map": [[0.8, 0, "appleOut"], [0.97, 6.2832]] } } }
```

A variable never takes a name the language already has (`time`, `sin`, `PI`, ...). An expression that does not parse or run is named in
the render's `scene.warnings` and leaves the field to its keys or its value.

### The editor's ƒx on Scene keys (`fx`)

`"fx": { "<field>": { "<type>": params } }` runs one of the Video Editor's keyframe expressions on that field's keys, the very functions a
layer's track ƒx runs ([video-keyframes.md](video-keyframes.md#track-expressions-propertykeyframefx)), with key times in seconds: `glide` (a preset
`"soft"`, `"floaty"`, `"trailing"`, `"endless"`, or `{ fast, slow, weight, delay }`, `weight` in percent as the editor's Tail Share),
`elastic`, `spring` (`"snappy"`, `"gentle"`), `bounce`, `wiggle` (`{ amp, freq }`, `amp` in the field's units) and `custom` (the expression
text). `true` takes the defaults. One ƒx a field; a vector field takes it on each number. A field with no keys has nothing for it to work on.

```json
"keys": { "rot": [{ "t": 0, "v": [0, -90, 0], "ease": "aeOut" }, { "t": 0.8, "v": [0, 0, 0] }] }, "fx": { "rot": { "glide": "soft" } }
```

### Follow path (`path`)

```json
"path": { "points": [[0.13, 0.78, -0.27], [-0.2, 0.4, 0.1], [0.05, 0.05, 0.04], [0, 0, 0]], "orient": false },
"keys": { "along": [{ "t": -0.333, "v": 0, "ease": "aeIn" }, { "t": 1.267, "v": 1 }] }
```

The object rides a curve through `points` (metres, in its parent's space, measured from its own `at`: keep `at` [0, 0, 0] to ride the
curve itself). `along` (0 the first point, 1 the last) is the share of the curve's length, so a linear `along` is an even speed and the
ease of its keys or its drive is the speed's own. `tension` [0.5] bends it as a Catmull-Rom spline through the points (0: straight lines),
`closed` joins its ends (`along` past 1 goes round again). `orient: true` turns the object so its +Z runs the way the curve goes and its +Y
leans toward `up` [[0, 1, 0]]; `bank` (degrees, keyable and drivable) rolls it about that direction, and its own `rot` turns it within that frame.

### Riding a Scene object (`parent` and `worldParent`)

- A `layers2d` card takes `"parent": "<object id>"`: its `at` and `rot` (keys and drives included) are an offset in that object's space,
  and it moves, turns and scales with the object, as a child object does.
- A 3D Text layer, a flat text layer with `textInWorld` and a picture layer with `inWorld` take `"worldParent": "<object id>"` on their item:
  the layer's own transform (`panX`, `panY`, `panZ`, its turns and scale, its keys and Text Animators) is placed in that object's space,
  one metre of it being 1000 pixels as in [placing 3D Text](#placing-3d-text-in-the-world), and the object carries it: its keys, drives,
  path and parents, in Draft and Final and through a motion-blurred shutter. A flat layer that rides an object stands in the world, not on
  the Scene camera. A title under a logo is `worldParent` on the title and nothing copied: the logo's spin, its shrink and its swirl carry
  the word. An id the Scene does not have is named by the project check (`unknown_ref` at `worldParent`), and the layer stands where its
  own transform puts it.

### The pattern

1. **One clock per move.** Two keys, `smoothGlide`, `filter: { "glide": "soft" }`. Everything in the move drives from it.
2. **Each channel its own remap of the app's eases.** Logo out `natural` (u 0 to 0.24); objects grow `aeSmooth` (0 to 0.28), hold
   (`linear`), shrink `[0.645, 0.045, 0.355, 1]` (Smooth, 0.59 to 0.86); spread out and back the same Smooth; the camera out with the burst
   (Smooth, 0 to 0.33) and back through the glide (`aeOut`, 0.33 to 0.92); the next logo in `appleOut` (0.8 to 0.97). Turns that should
   speed up and slow down with the move are `linear` in u (the globe's 270 degrees, a spin of five turns).
3. **Short contrasting phases.** With that clock: the explosion is about 15 frames (u 0 to 0.3), the glide about 35 (0.3 to 0.58), the
   collapse about 9 (0.58 to 0.86). A fast phase next to a slow one is what reads as design; even pacing reads as slow.
4. **Entries already moving at frame 0.** Key an entry from before 0 (`t` -0.333): the first frame is mid-move, not a start from rest.
5. **Nothing at rest is dead still.** A resting logo turns slowly and constantly: a second clock keyed linear over the whole shot
   (`{ "keys": [{ "t": 0, "v": 0, "ease": "linear" }, { "t": 12, "v": 1 }] }`) driving a few degrees a second, added to its other turns.
6. **Things ride things.** A title rides its logo (`worldParent`), a card its object (`parent`), an object its group (`parent`): one
   move on the parent, nothing copied.
7. **Motion blur on** (`"motionBlurEnabled": true`, a 180 degree shutter is Blender's 0.5 frame): drives, ƒx and paths blur like keys.

### A worked example

A logo film's first move (a logo, a cloud of objects, the camera, the next logo): one clock, every channel a remap. `M` is the media folder; the cloud's other objects repeat `pencil` with their own rest place. Its camera rides the Scene's clock (a `drive`), which only `scene.camera` does.

```json
{
  "clocks": {
    "move1": { "keys": [{ "t": 1.533, "v": 0, "ease": "smoothGlide" }, { "t": 3.4, "v": 1 }], "filter": { "glide": "soft" } },
    "rest": { "keys": [{ "t": 0, "v": 0, "ease": "linear" }, { "t": 12, "v": 1 }] }
  },
  "camera": { "fov": 41.26, "fStop": 1.6, "focus": "@logo",
    "drive": {
      "at": { "expr": "[0, -0.045 + 0.045 * z + (1.38 + 1.34 * z) * (1.015 - 0.003 * time) * 0.0698, (1.38 + 1.34 * z) * (1.015 - 0.003 * time) * 0.9976]",
              "vars": { "z": { "clock": "move1", "map": [[0, 0, [0.645, 0.045, 0.355, 1]], [0.33, 1, "aeOut"], [0.92, 0]] } } },
      "target": { "clock": "move1", "map": [[0, [0, -0.045, 0], [0.645, 0.045, 0.355, 1]], [0.33, [0, 0, 0], "aeOut"], [0.92, [0, -0.045, 0]]] } } },
  "objects": [
    { "id": "logo", "path": { "points": [[0.13, 0.78, -0.27], [-0.25, 0.42, -0.05], [-0.13, -0.01, 0.09], [0.06, -0.02, 0.04], [0, 0, 0]] },
      "keys": { "along": [{ "t": -0.333, "v": 0, "ease": "aeIn" }, { "t": 1.267, "v": 1 }],
                "scale": [{ "t": -0.333, "v": 0.55, "ease": "aeIn" }, { "t": 1.267, "v": 1 }],
                "visible": [{ "t": 0, "v": true }, { "t": 2.1, "v": false }] },
      "drive": { "scale": { "clock": "move1", "map": [[0, 1, "natural"], [0.24, 0]] } } },
    { "id": "logoSpin", "parent": "logo",
      "keys": { "rot": [{ "t": -0.333, "v": [0, -720, 0], "ease": "aeIn" }, { "t": 1.267, "v": [0, 0, 0] }] },
      "drive": { "rot": [{ "clock": "rest", "map": [[0, [0, -11.5, 0], "linear"], [1, [0, 91.7, 0]]] },
                         { "clock": "move1", "map": [[0, [0, 0, 0], "linear"], [1, [0, 1800, 0]]] }] } },
    { "id": "logoTilt", "parent": "logoSpin", "model": "M/clover.glb",
      "keys": { "rot": [{ "t": -0.333, "v": [40.1, 0, 0], "ease": "aeIn" }, { "t": 1.267, "v": [0, 0, 0] }] } },
    { "id": "cloud", "keys": { "visible": [{ "t": 0, "v": false }, { "t": 1.5, "v": true }, { "t": 3.633, "v": false }] },
      "drive": { "rot": { "clock": "move1", "map": [[0, [0, -121.5, 0], "linear"], [1, [0, 148.5, 0]]] },
                 "scale": { "clock": "move1", "map": [[0, 0.9, "linear"], [1, 1.22]] } } },
    { "id": "pencil", "parent": "cloud", "model": "M/pencil.glb", "rot": [12, -40, 8],
      "drive": {
        "at": { "clock": "move1", "map": [[0, [0, 0, 0], [0.645, 0.045, 0.355, 1]], [0.32, [0.21, 0.06, -0.12], "linear"], [0.58, [0.21, 0.06, -0.12], [0.645, 0.045, 0.355, 1]], [0.86, [0, 0, 0]]] },
        "scale": { "expr": "min(s, 6 * p)",
                   "vars": { "s": { "clock": "move1", "map": [[0, 0, "aeSmooth"], [0.28, 1, "linear"], [0.59, 1, [0.645, 0.045, 0.355, 1]], [0.86, 0]] },
                             "p": { "clock": "move1", "map": [[0, 0, [0.645, 0.045, 0.355, 1]], [0.32, 1, "linear"], [0.58, 1, [0.645, 0.045, 0.355, 1]], [0.86, 0]] } } } } },
    { "id": "next", "keys": { "visible": [{ "t": 0, "v": false }, { "t": 3.333, "v": true }] },
      "drive": { "scale": { "clock": "move1", "map": [[0.8, 0, "appleOut"], [0.97, 1]] } } },
    { "id": "nextSpin", "parent": "next", "model": "M/clover.glb",
      "drive": { "rot": [{ "clock": "rest", "map": [[0, [0, -45.8, 0], "linear"], [1, [0, 57.3, 0]]] },
                         { "clock": "move1", "map": [[0.8, [31.5, -720, 0], "appleOut"], [0.97, [0, 0, 0]]] }] } }
  ]
}
```

And the next logo's title, a 3D Text layer that rides it: `{ "textContent": "Video Editor", "text3d": { "enabled": true }, "panY": 12.34, "panZ": 35, "worldParent": "next" }`
(0.237 m under the logo's middle on a 1920 px tall frame, 35 mm in front of it).

Rebuilt this way, the Blender build's first move (its clock, every remap, its phases and its follow-path entry) lands on Blender's own
frame by frame: 53 channels within 0.4 % of their range, none a frame off.

## Ops

Every line is `op { params }`: what it does. Defaults are in brackets; every param is optional unless marked **required**. Sizes
are metres, angles degrees. `size` may be a number or `[x, y, z]`. Sources made from a size (box, sphere, cylinder, cone, torus,
capsule, plane, grid) are centred on the origin; sources made from coordinates you give keep them (a `lathe` profile's y, the points of
`tube`, `ribbon`, `pointsOnCurve`, `sdf` and `skin`, an `extrude` outline's x and y, with its depth centred on z = 0), and `text`
stands on y = 0. A cylinder 0.08 tall therefore runs from y = −0.04 to 0.04: move it with `transform` or the object's `at`.

A node is `{ "op": "...", ...params, "id": "...", "in": ... }`. **Sources** (the first two groups) take no input, so a source in
the middle of a graph does not chain from the node above it: build the parts, then join them by id.

```json
[
  { "op": "box", "id": "body", "size": 1, "bevel": 0.05 },
  { "op": "cylinder", "id": "hole", "radiusTop": 0.2, "radiusBottom": 0.2, "height": 2 },
  { "op": "boolean", "in": ["#body", "#hole"], "mode": "subtract" },
  { "op": "smooth", "angle": 40 }
]
```

### Solids

- `box { size [1], segments [1], bevel [0], bevelSegments [4] }`: `size` is one number (a cube) or `[x, y, z]`, and so is `segments`. `bevel` is the rounding radius, real rounded edges and corners, too big is clamped. `bevelSegments` counts around a 90-degree edge and rounds up to even; 1 is a flat chamfer. Its own uvs are for patterns: a picture (`maps.base`) comes out upside down on its front and back and turned a quarter on the other four faces; for a picture use `decal`, `uvTriplanar`, or `uvPlanar` with the flips given there.
- `sphere { radius [0.5], segments [32], rings [16] }`.
- `cylinder { radiusTop [0.5], radiusBottom [0.5], height [1], radial [32], bevel [0], bevelSegments [4], caps [true] }`: `bevel` rounds both rims.
- `cone { radius [0.5], height [1], radial [32], bevel [0], bevelSegments [4] }`.
- `torus { radius [0.5], tube [0.15], radial [16], tubular [48] }`: lies flat around Y. `radial` goes round the tube, `tubular` round the ring.
- `capsule { radius [0.25], height [1], radial [24], rings [8] }`: `height` is the whole capsule, caps included.
- `lathe { profile **required**, segments [32], angle [35], closed [false], round [0], roundSegments [6] }`: spins `[[radius, y], ...]` around Y. Either drawing direction works. A profile starting and ending at radius 0 is a closed solid; `closed` joins the last point to the first (a ring). `angle` is the sharp-corner limit: a bend sharper than it is a crease. `round` (metres) turns every corner of the profile into an arc, so a bottle whose shoulder is drawn as two straight runs shades as one smooth surface instead of a crease and a flat band: give bottles, jars and caps `round` 0.003 to 0.01 (for 10 to 30 cm), or draw the profile with enough points.
- `extrude { polygon | shape | svg **required**, depth [0.1], bevel [0], bevelSegments [3], curveSegments [12] }`: pushes a 2D outline along Z. `depth` is the whole thickness, centred on z = 0. The bevel cuts into the outline, so the silhouette stays exact; keep it under half the thinnest stroke and under half the depth.
  - `polygon`: `[[x, y], ...]`, with `holes: [[[x, y], ...], ...]`.
  - `shape`: `{ outer, holes }`, `{ rect: [w, h], radius }` or `{ circle: r }`.
  - `svg`: a path `d` string or a whole `<svg>`. M L H V C S Q T A Z, absolute and relative, holes from nesting. `size` fits the longer side to that many metres, `center` [true], `flipY` [true].
- `tube { path **required**, radius [0.02], radial [12], closed [false], tension [0.5], segments [auto], caps [true] }`: Blender's curve with bevel depth. `path` is `[[x, y, z], ...]`, a spline through those points. `tension` 0 is the straight polyline.
- `text { text **required**, size [0.2], depth [0.05], bevel [0], bevelSegments [3], curveSegments [6], align ['center'] }`: Droid Sans Bold. `size` is about the capital height. Letters stand on y = 0 and run along +X. `align` is left, center or right.

### Sheets and points

Sheets lie flat on XZ facing +Y, unlike three's upright plane. Point sources make points, not triangles.

- `plane { size [1], segments [1] }`: `size` and `segments` take a number or `[x, z]`. Its own uvs put a picture's top row toward +z, so a camera standing at +z sees it upside down; after `uvPlanar` with `axis: 'y'` it reads upright from there.
- `grid { size [1], segments [10], cols, rows }`: a plane with more cells.
- `pointsGrid { size [1], count | spacing [0.1], jitter [0], seed [0], y [0] }`: points on XZ with both edges included, x running first, row 0 at -Z. `count` is a number or `[x, z]`. `jitter` 1 moves a point up to half a cell.
- `pointsOnCurve { path **required**, count | spacing [0.1], closed [false], tension [0.5] }`: even spacing along a spline. N and orient follow the tangent, so `align: "normal"` lines +Y up with the path.

### Modifiers: one input, the node before unless `in` says otherwise

- `transform { at, rot, scale }`: moves mesh, points and instances together. T * R * S, Euler XYZ like three.
- `solidify { thickness [0.01], offset [-1], angle [30] }`: adds thickness. -1 keeps the input as the outside and grows inward, 1 grows outward, 0 splits it. A sheet comes back a closed slab.
- `smooth { angle [30], weight ['area-angle'] }`: recomputes normals, sharp above `angle`. This is Weighted Normal: big flat faces stay flat next to small bevels. `weight` is area-angle, area, angle or none. It changes shading only, never positions.
- `hair { count [2000], length [0.1], lengthJitter [0.25], width [0.002], segments [8], droop [0.25], curl [0.1], curlScale [0.5], clumps [0], clumpAmount [0.7], lean [0.3], seed [0], root ['#3a2a1e'], tip ['#8a6a4a'] }`: strands grown from the input mesh as real geometry, seen by raster and the tracer alike. `root` and `tip` colour each strand. `clumps` is how many guides they gather around, which is what makes hair read as hair. Stay under about 50,000 strands for a responsive Draft.
- `displace { amount [0.05], scale [1], seed [0], octaves [3], angle [60] }`: seeded 3D noise along the normals, up to `amount` either way. `scale` is noise frequency per metre. Subdivide first; it only moves the vertices that exist.
- `twist { axis ['y'], amount [90] }`: rotates slices around `axis`, -amount/2 at one end of the mesh to +amount/2 at the other.
- `bend { axis ['y'], amount [90], toward [next axis] }`: curls a mesh that runs along `axis` into an arc of `amount` degrees, keeping its length, turning towards `toward`. The middle stays put.
- `taper { axis ['y'], amount [-0.5] }`: scales across `axis`, unchanged at the low end and `1 + amount` at the high end. -1 is a point.
- `wireframe { thickness [0.02], radial [6], joints [true], quads [true] }`: every edge becomes a strut, with a ball on each joint. `thickness` is the strut's diameter. `quads` leaves out the diagonals of quads. The struts are separate closed shells that overlap, so `boolean` union them if a single skin matters.
- `array { count [2], offset [[1, 0, 0]], rotate [[0, 0, 0]], scale [1] }`: each copy is the last one moved by the same step, so offset + rotate makes a spiral. Real geometry: for thousands of copies use points and `copyToPoints`.
- `radialArray { count [6], axis ['y'], radius [0], angle [360] }`: copies spun around `axis`, each first pushed out by `radius` (along x for the y axis).
- `mirror { axis ['x'], weld [true] }`: reflects across the plane through the origin and keeps both sides. `weld` (true or a distance) closes the seam and removes faces lying in the plane. Model the half with +x.
- `subdivideLinear { levels [1] }`: each triangle becomes four and the surface does not move. No smoothing: this is for `displace` to have vertices to push.
- `decimate { ratio, error, angle [40] }`: fewer triangles. `ratio` is the fraction to keep; `error` caps surface movement as a fraction of the mesh's size. A closed solid stays closed, so a very low ratio stops above its target. Keeps uv seams.
- `uvBox { scale [1] }`: per-face projection along the dominant axis. uv unit = 1/scale metres. The easy default for hard surfaces and patterns (wood, stone, fabric). Each face is projected as `uvPlanar` does along the axis it faces: top and bottom u = +x, v = +z; front and back u = +x, v = +y; sides u = +z, v = +y. So a picture comes out upside down on the front and back and mirrored on one side of each pair: for pictures use `decal`, or `uvPlanar` with the flips below.
- `uvPlanar { axis ['z'], scale [1], fit [false], offset [0, 0] }`: flat projection. `fit` maps the bounds to 0..1, then `scale` (a number or `[u, v]`) and `offset` place that square. A picture's top row is at v = 0, and the axes run:
  - `axis: 'y'`: u along +x, v along +z, so seen from above with +z toward you it reads upright. One cell of a picture atlas, such as a key's legend on a 10 × 10 sheet: `{ "axis": "y", "fit": true, "scale": 0.1, "offset": [col / 10, row / 10] }`.
  - `axis: 'z'`: u along +x, v along +y, so a picture comes out UPSIDE DOWN seen from +z (the front). Stand it upright with `{ "axis": "z", "fit": true, "scale": [1, -1], "offset": [0, 1] }`.
  - `axis: 'x'`: u along +z, v along +y, so seen from +x it is upside down AND mirrored: `{ "axis": "x", "fit": true, "scale": [-1, -1], "offset": [1, 1] }`; seen from -x, `"scale": [1, -1], "offset": [0, 1]`.
  - A label on a bottle or a box is easier with `decal` (below): its uvs come out upright with no flipping.
- `uvCylinder { axis ['y'], scale [1], repeat [1] }`: u wraps around `axis` `repeat` times, v is height * scale.
- `uvUnwrap { }`: a real atlas with no overlaps, uvs in 0..1, for baking. 65535 distinct points at most. `unwrap` (below) is usually better: seams, pins, less stretch, a stretch report.

### Several inputs: set `in`

- `boolean { mode ['union'], cutMaterial }`, `in: ["#a", "#b", ...]`: union, subtract (the first minus all the others) or intersect. Every input must be a closed solid, so `solidify` a sheet first. Untouched surfaces keep their shading, uvs, materials and vertex groups; the cut is a hard edge and wears the cutter's material, or slot `cutMaterial`. Colours are dropped.
- `merge { }`, `in: [...]`: joins meshes, points and instances without cutting anything.

### Points to copies

- `scatter { count | density **required**, seed [0], minDistance [0], relax [0], slope, height, mask }`: random points on the input mesh, evenly by area, with N from the surface. Attributes: P N pscale orient Cd id, plus `uv`.
  - `count` is a target; a surface that fills up under `minDistance` gives fewer. `density` is points per square metre, and a filter removes points in proportion.
  - `relax`: each point is the best of 1 + 4 * relax candidates, spreading them more evenly. Try 1 to 3.
  - `slope: [min, max]`: degrees from straight up. `height: [min, max]`: on y.
  - `mask`: an expression string using P, N, uv, noise(x, y, z) and returning 0..1 (`"P[0] > 0 ? 1 : 0"`), a JS function (P, N, uv), or `{ texture: { data, width, height, channel } }`. Values are a probability.
- `attrib { expr **required**, seed [0] }`: a wrangle, run once per point. In scope: `P N Cd orient` (arrays to write into), `pscale` (assign to it), `id i count`, `rand(n)` (0..1, per point; a different n is a different number), `noise(x, y, z)` (-1..1), and `attr` for custom attributes (`attr.kind = rand(1) < 0.5 ? 0 : 1`). Math works and is seeded. fetch, document, window, globalThis, process, Date and eval are undefined. Changing N re-aims orient unless the expression also sets orient.
- `copyToPoints { align ['normal'], randomRotate, randomScale, pick ['random'], seed [0], sources }`: instances of meshes on points, one instances entry per source. Input is the points, then the sources: `in: ["#pts", "#rock", "#tree"]`, or `in: "#pts", sources: ["#rock", "#tree"]`. `align` is normal (+Y along orient) or up (upright). `randomRotate: [x, y, z]` is degrees either way. `randomScale: [a, b]` multiplies pscale. `pick` is random or `attr:<name>` (a custom attribute, floored, modulo the sources). Cd becomes instance colour: linear RGB, multiplying the material's `base` (see `script` for converting a hex colour).
- `instanceRealize { }`: bakes instances into one real mesh, with colours in the optional `mesh.color` (3 per vertex). Use it before a modifier or boolean.

Meshes, points and instances are different kinds of output. A modifier needs a mesh, and says so if it gets something else.

### Harder shapes

- `sdf { shapes **required**, blend [0.1], resolution [64], voxel }`: solids that melt into each other like clay. A source. Each shape is `{ type, at, rot, ... }`, where `rot` is degrees, as on objects:
  - `sphere { radius }`, `box { size, round }`, `capsule { height, radius }`, `cylinder { radius, height, round }`, `torus { radius, tube }`;
  - `stroke { path, radius }`: clay along a path, `[[x, y, z], ...]` or `[[x, y, z, radius], ...]` so it can swell and thin; `radius` may also be one number per point.
  - `subtract: true` carves, and a shape's own `blend` overrides the op's. A shape's `material` (a slot) colours the part of the surface it makes, a carved hollow included. Raise `resolution` (cells across the longest side) or set `voxel` (cell size in metres) for detail; the cost is its cube.
- `skin { paths | points + edges, radius [0.05], blend [0.02], resolution [64], voxel, smooth [1] }`: a body around a skeleton, Blender's Skin modifier. A source. `paths` is a list of branches, each `[[x, y, z, radius], ...]`; a branch that starts on another's point grows out of it. Or `points` with `edges: [[i, j], ...]` and `radius` as one number or one per point. Each bone tapers from one radius to the next and the joints melt together by `blend`. Ends are round. Use it for limbs, stems, cables with a bulge, creatures.
- `softUnion { blend [0.1], resolution [48], voxel }` with `in`: any closed meshes melted into one. About a second at 64.
- `remesh { resolution [64] | voxel, smooth [0], uv [false] }`: Blender's voxel remesh. The mesh comes back as an even skin of small triangles from the volume it encloses: overlapping parts become one body, long thin triangles become even ones, and sharp edges round off by about a cell. It needs a closed solid. Materials, region names and vertex groups come along; uvs only with `uv: true` (seams kept), else project again after it (`uvBox`). Do this before `inflate`, `displace` or anything that needs even triangles.
- `relax { iterations [5], strength [0.5], keepVolume [true], boundary [false] }`: smooths the surface itself, Blender's Smooth modifier (`smooth` only changes shading). With `keepVolume` it softens without shrinking. Open edges stay put unless `boundary`.
- `subdivide { levels [1], sharp [0], box | sphere | mask }`: Blender's Subdivision Surface (Catmull-Clark). Triangulated quads are paired back first, so a box comes out round and even. `sharp` keeps edges sharper than that many degrees as hard creases (a box with `sharp: 30` keeps its outline and rounds nothing; use it with more `segments` for a soft box with crisp edges); picked points crease too. Each level is 4 times the triangles: stay at 2 or 3.
- `bevel { width [0.02], segments [3], angle [30], profile [0.5], clamp [true], box | sphere | mask }`: Blender's Bevel with the Angle limit, on any edges sharper than `angle`, which is what makes a product catch light on its edges. `width` is how far it cuts into each face (the radius on a right angle). `segments: 1` is a chamfer; `profile` 0.5 is round, 0.25 a straight cut, towards 1 sharper, towards 0 a cove. A pick limits it to edges with both ends picked. Corners where three bevels meet are rounded properly. The mesh must be manifold where it bevels. Textured? `uvBox` after it.
- `inflate { pressure [1.6], shrink [0], steps [90], stretch [0.0005], bend [0.02], pin, smooth [0] }`: blows a closed mesh up like a pillow, a cloth with air in it settled to rest: puffy keys, throw pillows, balloon letters. `pressure` is the volume it ends at, as a multiple of the start; flat sides bulge and edges pinch. `shrink` (up to 0.3) shrinks the cloth before the air goes in, so it ends taut. Needs even triangles: a `box` with `segments` 16 or more, or `remesh` first.
  - **It makes a flat slab much taller, whatever the numbers.** Measured on a 0.6 × 0.16 × 0.6 m seat cushion: `bevel` → `remesh` → `inflate` came out 0.33 to 0.43 m tall (2.1 to 2.7 times) for every `pressure` from 1.05 to 1.6 and `shrink` from 0.05 to 0.14, with the footprint 3 to 12 % smaller; `segments` 16 and `shrink` 0 came out 0.28 m (1.7 times). A thinner start does not help: 0.065 and 0.1 m slabs came out 0.25 and 0.40 m tall, their footprint drawn in to 0.46 m. The air goes to the middle: the result is a lens, round on top and pinched at the edges. To keep that look but lower, follow it with `{ "op": "transform", "scale": [1, 0.45, 1] }`.
  - **So not for upholstery.** Sofa seat and back cushions, mattresses and padded panels keep their size as a bevelled box: `{ "op": "box", "size": [0.6, 0.16, 0.6], "bevel": 0.03, "bevelSegments": 6 }`, or for a soft crown `{ "op": "box", "size": [0.6, 0.16, 0.6], "segments": 4, "bevel": 0.04 }` then `{ "op": "subdivide", "levels": 1 }`. A `weave` or `noise` pattern and `sheen` 0.3 make them read as fabric.
  - **Puffy things:** smooth, taut pillows (throw pillows, lentil-shaped keys, a long space bar) are `bevel`, then `remesh`, then `inflate` with `shrink` 0.1 to 0.15; check the size it ends at with `inspect` and scale it after. Crinkled, mylar-like pillows with pinched corners are a `box` with `segments` 16 and `shrink` 0: the slack folds at the corners.
  - Without `shrink`, slack cloth has to buckle somewhere: on a long, thin shape the middle sinks below its edges (a trough), and a remeshed shape crinkles all over.
  Each shell gets its own air. `pin` (`box`, `sphere` or `mask`) holds points still. Normals come out smooth.
- `drape { steps [150], thickness [0.004], friction [0.6], floor, pin, gravity, stretch [0], bend [0.002], resolution [64] }` with `in: [cloth, collider, ...]`: the first input falls onto the rest and settles: a tablecloth, a throw over a chair, a sheet over a statue. The cloth needs vertices (`grid` with 48 to 96 segments). `floor` is a height it cannot pass. Inputs from `@object` arrive in that object's own space, so give the cloth the same placement or line them up with `transform`. The cloth does not collide with itself, and colliders thinner than two grid cells need a higher `resolution`.
- `project { direction [[0, -1, 0]], offset [0], from [0] }` with `in: [what, onto]`: lays a mesh on another, like shrinkwrap. Each point drops to the first surface along `direction`, and points that miss go, unless `keep: true`. `offset` keeps it clear of the surface and `from` starts the ray further back.
- `ribbon { path **required**, width [0.1], twist [0], taper [1], closed, tension, segments }`: a flat strip along a path. A source. Give its material `doubleSided: true`.
- `wrangle { code **required**, seed }`: runs on every point. `P`, `N` and `uv` are arrays to change in place, with `i`, `count` and `noise(x, y, z)` to hand: `"P[1] += noise(P[0] * 4, 0, P[2] * 4) * 0.1"`.
- `deletePoints { box | sphere | mask }`: takes points away, and every triangle using one. `box` is `{ min, max }`, `sphere` is `[x, y, z, radius]`, and `mask` is an expression over `P`, `N`, `uv` and `noise` that is above 0.5 for the points to go.
- `assign { material [1], name, box | sphere | mask | region | facing | group }`: gives picked triangles another material. Name them on the object: `"materials": ["paint", "chrome"]`, where the number is the place in that list. `name` makes the slot a named region that later nodes pick with `region` (a new name with no `material` takes the next free slot). Every op carries the slots on: ops that keep or split triangles exactly, and ops that build a new surface (`boolean`, `remesh`, `softUnion`, `decimate`, `wireframe`) by nearest surface. A slot past the object's `materials` list wears the object's own `material`.

### Editing a mesh, UVs and decals

Edits work on the faces of a mesh you already have, as nodes, so the whole history stays editable: change the box's size and the inset, the cut panel and the label all follow. Faces are the polygons the triangles came from (a box face is one quad). Untouched faces keep their uvs, materials and normals exactly, hand-set normals included; new faces shade smooth below `angle` [30].

**Picking faces.** Every edit takes the usual `box | sphere | mask` (a face is picked when all its points are) plus `region: "label" | 2 | [..]` (a named region or slot), `facing: [0, 1, 0]` or `{ "dir": [0, 1, 0], "angle": 30 }` (faces looking that way), `group: "top"` or `{ "name": "top", "min": 0.5 }` (faces whose points all weigh that much). Everything given must hold; `invert: true` flips it.

- `inset { thickness [0.01], depth [0], individual [false], name, material, sides, pick }`: a border `thickness` wide inside the picked region (each face its own with `individual`); `depth` moves the inside in (−) or out. `name` makes the inside a region (its own slot) for the next node; `sides` gives the border faces a slot.
- `extrudeFaces { distance [0.05], along ['region'], individual, name, material, sides, pick }`: moves the picked faces with walls joining them to where they were. `along`: `'region'` (the region's mean normal), `'normals'` (each point along its own, even thickness), or `[x, y, z]`. Negative pushes in: a recessed panel is `inset` with a `name`, then `extrudeFaces { region: name, distance: -0.003 }`.
- `loopCut { axis ['y'] | [x, y, z], cuts [1] | at }`: rings of new edges where planes across `axis` cross the surface, `cuts` spread evenly or at the offsets in `at`. Nothing moves; it gives the next pick a line to stop at.
- `bridge { segments [1], twist [0], material, name, pick }`: joins two open loops with a band. With a pick, the picked faces go first and the holes they leave are joined (two facing panels make a tunnel); without, the mesh's own two open loops. Unequal loops zip with triangles.
- `weld { distance [0.0001] }`: merges points closer than that, drops collapsed and doubled triangles. Closes cracks between parts.
- `fillHoles { sides [0], material }`: caps open loops of up to `sides` edges (0 any), flat in their own plane.
- `recalcNormals { angle [30], inside [false] }`: turns every face the same way as its neighbours and every part outward. For imported or scripted meshes that shade black in patches.
- `setNormals { mode ['smooth'], direction, center, axis, pick }`: hand-set normals on the picked faces (all if none): `smooth` (no hard edges), `flat`, `direction` (foliage cards facing up), `outward` from `center` (a soft bush), `cylinder` (away from the `axis` through `center`). Later ops keep them where the surface stays (moves, mirrors, booleans, unwraps, decals, edits elsewhere); ops that reshape it (`smooth`, `subdivide`, `bevel`, `remesh`) work them out again.
- `vertexGroup { name **required**, weight [1], mode ['set'], falloff, pick }`: a named weight per point, 0 to 1, stored as `mesh['group:<name>']` (a Float32Array per vertex). `box`/`sphere` give 1 inside (`falloff: 'linear' | 'smooth'` fades a sphere to its edge), a `mask` its own value (`"P[1] * 2"`), the face picks keep their points. `mode`: set, replace, add, subtract, max, multiply. Ops that take a `group` read it; groups ride through every op, interpolated on new points.

**UVs.**

- `seams { angle | pick, mode ['add'] }`: marks where `unwrap` must cut: edges sharper than `angle`, edges with both points in a `box`/`sphere`/`mask` (draw a seam with a thin box), or the border of faces picked by `region`/`facing`/`group`. `mode: 'clear'` unmarks. Mark them right before the unwrap.
- `pins { list: [{ at: [x, y, z], uv: [u, v] }] | pick }`: points `unwrap` must put at exact uvs (the mesh point nearest each `at`); a pick pins its points where their uvs are now. A piece with two or more pins is solved through them and not repacked. Four corners pinned to the picture's corners, with the picture's `aspect`, lay it exactly on a curved card.
- `unwrap { angle [66], bySlot [true], margin [0.005], tiles [1], aspect [1], maxStretch [1.25] }`: a conformal unwrap (least-squares conformal maps) with low stretch. It cuts at marked seams, edges sharper than `angle` and material borders, opens closed pieces and cone tips, splits any piece that would fold, overlap or stretch past `maxStretch`, gives every piece the same texel density and packs them into 0..1 with `margin` between (or across `tiles` UDIM tiles). Pictures read the right way round from outside (never mirrored); which way up a piece lies is the packer's choice, so pin it when that matters. `aspect` is the texture's width over its height: give it for a picture that is not square, or it lands squeezed. The result reports `mesh.uvStats`: `{ charts, l2, worst, angle, flipped, fill }`, where `l2` is texture stretch (1 is none; under 1.01 is invisible), `worst` the stretch 95 % of the area stays under, `flipped` folded triangles. Prefer it to `uvUnwrap`.
- `udim { material [0] }`: uvs in UDIM tile 1001 + col + 10 · row become slot `material` + that offset, with uvs back in 0..1, so each tile is an ordinary material with its own maps, the same in Draft and Final: `"materials": ["tile1001", "tile1002"]`. Regions are named `udim1001`, `udim1002`, ….
- `uvTriplanar { scale [1], offset }`: each face takes the picture from the side it faces most, in metres, all six sides the right way round (`uvBox` mirrors three). It switches sides at 45 degrees with no blend band; for one continuous map use `unwrap`.

**Decals: a label on a product.** `decal` cuts the mesh exactly along the label's edges, so the label's border is geometry (crisp in Final at any distance), and gives its faces uvs 0..1 across the label with the picture's top row at v = 0.

- `decal { projection ['box'], at, normal [[0, 0, 1]], up [[0, 1, 0]], size **required** [w, h], depth, angle [70], material, name ['decal'], mode ['region'], offset [0.0004], flip }`:
  - `box`: `at` is the label's middle on the surface, `normal` the way it faces; it reaches `depth` [half the smaller side] either side of `at`. For a box face or a flat panel.
  - `cylinder`: `axis` [[0, 1, 0]], `at` a point on the axis at the label's middle height, `normal` from the axis towards the label's middle; `size` is [width along the surface, height], so it wraps with no stretch; `radius` is measured when left out. For bottles, jars, cans and tubes.
  - Faces turned more than `angle` away are left out, so a label never smears down a side.
  - `mode: 'region'`: the label's faces become a region with their own slot, for an opaque label (paper, foil). Give that slot a material with the picture in `maps.base`: `"materials": ["glass", "label"]`.
  - `mode: 'layer'`: a sheet `offset` above the surface for a picture with see-through parts (a logo); its material reads the picture's alpha with `"alphaFromBase": true`. The object stays whole underneath, but the sheet is open, so put a layer decal after any `boolean`.
- `shrinkwrap { mode ['nearest'], offset [0], direction, both, keep }`, `in: [what, onto]`: lays one mesh on another, each point to the nearest surface point taking its normal, or (`mode: 'project'`) along `direction` (`'normal'`: along each point's own normal). What finds nothing goes unless `keep`.

A box with a recessed panel and a label, every step editable:

```json
[
  { "op": "box", "id": "body", "size": [0.18, 0.24, 0.06], "bevel": 0.004 },
  { "op": "inset", "thickness": 0.012, "facing": { "dir": [0, 0, 1], "angle": 5 }, "name": "panel" },
  { "op": "extrudeFaces", "region": "panel", "distance": -0.002 },
  { "op": "decal", "at": [0, 0, 0.028], "normal": [0, 0, 1], "size": [0.12, 0.06], "depth": 0.004, "name": "label" }
]
```

with `"materials": ["paint", "paint", "paper"]` on the object (body, panel, label).

### Deforming, sculpting and organic shapes

**Vertex groups.** A group is a named weight per point, 0 to 1, kept on the mesh as `group:<name>`. Ops that only move points carry
groups on. The weight ops below write them. Every deformation takes `weights: "group:<name>"` (or a number) to scale its effect point by
point: 0 stays put, 1 is the full op. This works on `bend`, `twist`, `taper`, `displace`, `wrangle`, `relax`, `transform`, `lattice` and
`sculpt`. Without `weights` they behave as before. A name the mesh does not carry is an error that lists the groups it does carry.
Ops that rebuild the points (`subdivide`, `remesh`, `smooth`, `boolean`...) may drop groups, so make weights after them.

- Each weight op writes `group` ['weight'] and combines with a group of that name already there by `mode`: replace (default), add,
  subtract, multiply, max or min. Shaping: `falloff` (linear, smooth, sharp, root), `ramp` (`[[t, w], ...]` or evenly spaced
  `[w0, w1, ...]`) and `invert`.
- `weightGradient { axis ['y'], from, to | path }`: 0 at `from`, 1 at `to` (default: the mesh's two ends on that axis). With `path`, the
  weight is the share of the way along it at the nearest point.
- `weightProximity { point | path, radius [0.25], inner [0], falloff ['smooth'] }`: 1 within `inner` of a point or a path, 0 from
  `radius` out. Near another mesh: `in: ["#this", "@other"]`, measured to its surface.
- `weightNoise { scale [2], octaves [3], contrast [1], offset [0], seed }`: seeded noise around 0.5.
- `weightMask { mask | box | sphere, soft [0] }`: an expression over `P`, `N`, `uv`, `w` (the group so far) and `noise`, returning 0..1
  (`"P[1] > 0.2 ? 1 : 0"`). Or a `box` / `sphere` with `soft` metres of fade at its edge.
- `weightSmooth { iterations [4], strength [0.5] }`: blurs a group over the surface.

**Lattice.** `lattice { divisions [[3, 3, 3]], box, points | moves, interpolation ['bezier'], weights, shapeKey, value [1] }` is a cage of
control points around the mesh (its bounds by default, or `box: { min, max }`). Moving the cage's points bends everything inside it
smoothly. This is free-form deformation, and points outside the box stay where they are.
- `divisions` is the number of control points per axis, 2 to 12. A point is `[i, j, k]` from the low corner.
- `moves: [{ at: [i, j, k], by: [dx, dy, dz] }]` moves a few points. `points` lists every point's move, x fastest, then y, then z.
- `interpolation: 'linear'` bends in straight pieces instead.
- `shapeKey: "name"` leaves the mesh as it is and makes the bend a shape key, so it plays on the timeline (see below) at weight `value`.

**Shape keys.** `shapeKeys { targets: [{ name, value [0], graph | input | frames }] }` keeps the input as the basis and adds named poses
of the same points.
- `graph` is a chain of ops run on the basis: `[{ "op": "bend", "amount": 40 }]`, a `lattice`, a `sculpt`, a `wrangle`. Inside it,
  `"in": "@basis"` names the basis.
- `input: 1` is this node's second input (`in: ["#base", "#other"]`), which must have the same points.
- `frames: [{ at: 0.5, graph }, { at: 1, graph }]` gives in-between poses. A move between frames follows them (a turn stays round),
  and past the last frame it carries on along the last step.
- The output shows each key at its `value`. On the timeline, the object's `"keys": { "shape:<name>": [{ "t": 0, "v": 0 }, { "t": 2, "v": 1 }] }`
  plays it, and `"shapes": { "<name>": 0.4 }` on the object sets it without a track.
- A frame only mixes the poses into the mesh's own buffers. It never rebuilds the world: on a 100K-triangle mesh this costs about 2 ms
  a frame. Final traces each pose, and keys blur in an export with motion blur on.
- Put `shapeKeys` near the end. Ops after it that only move points keep the keys, and `transform` turns them with the mesh. Ops that
  rebuild points (`subdivide`, `remesh`, `boolean`...) drop them.

**Sculpt strokes.** `sculpt { strokes: [...], weights }` holds the strokes as data. They stay editable, and they run again on whatever
comes in after an upstream edit: a bigger sphere above them gets the same strokes on its own surface.
- A stroke is `{ brush, path: [[x, y, z], ...], radius [0.05], strength, falloff ['smooth'], symmetry, project ['surface'], spacing [0.25] }`.
  The path is in the object's own space (world space for an object at the origin). One point is a single dab; a longer path drags the
  brush, with a dab every `spacing` radii.
- Brushes:
  - `draw` raises along the area's normal; a negative `strength` carves.
  - `inflate` pushes each point along its own normal.
  - `grab` carries what was under the path's start along the path; `snakeHook` takes hold again at every dab, pulling out a horn
    or a tentacle.
  - `smooth` relaxes the surface.
  - `crease` cuts a sharp groove (`pinch` [0.5] pulls the sides in); `pinch` only pulls them in.
  - `flatten` moves points onto the area's plane; `clay` builds up flat-topped layers.
  - `falloff` is smooth, sphere, sharp, linear or constant.
- Aiming: by default each dab lands on the nearest surface. `project: [dx, dy, dz]` shoots it along that direction instead (from the
  camera's side, e.g. `[0, 0, -1]` for a surface facing +z). `project: false` uses the path exactly.
- `symmetry: "x"` (or `"xz"`) mirrors the stroke across those planes through the origin.
- `backfaces: true` also moves the points facing away.
- Strokes move the points that exist, so give the mesh enough of them: about 8 or more across a dab's radius. `remesh` or `subdivide`
  first, or a source with more `segments`.

**Petals, leaves, flowers and stems.** Sources for organic hero shapes, each a smooth sheet with clean uvs.
- `petal { length [0.5], width [0.3], outline ['tulip'], tip, tipShape, cup [70], curl [30], curlPower [1.6], flare [0], twist [0], ruffle [0.004], ruffleFrequency [3], ruffleDepth [0.35], midrib [0.003], thickness [0], thicknessTip [0.4], baseColor ['#eef0c8'], tipColor ['#ffffff'], segments [[28, 48]], seed }`:
  - It stands on its base at the origin and grows along +Y, its outer face toward +Z. u runs across (0 to 1) and v along (base to tip).
  - `outline`: tulip, rose, oval, round, lance or heart, or a list of widths along the body as shares of `width`. The last `tip` of the
    length closes as a superellipse: `tipShape` 0 is round, 1 pointed, below 0 square.
  - `cup` is the degrees of arc across the widest row, edges curling toward -Z. `curl` is the degrees the centre line turns toward the
    cup by the tip (negative arches it back). `flare` turns the top quarter outward, a lip (a flower head's petals have 12). `twist` is
    in degrees.
  - `ruffle` is the edge's waves in metres, `ruffleFrequency` waves per side, within `ruffleDepth` half-widths of the rim. `midrib` is a
    keel down the middle in metres (negative: a groove).
  - `thickness` above 0 makes a closed slab that is thinner toward the tip (`thicknessTip`) and the rim. 0 is one sheet: give its
    material `doubleSided: true`.
  - Every shape of the same `segments` has the same points, so petals make good shape keys.
  - It writes `group:edge` (0 on the rim, 1 a half-width in; the base counts as inside), `group:along` (0 base to 1 tip) and
    `group:thick` (how thick a real petal is there: full at the base, thinner toward the tip, nothing at the rim).
  - `baseColor` to `tipColor` is a tone along it as vertex colours, which multiply the material's: yellow-green at the base, creamy
    at the tip by default. `null` for none.
- `leaf { length [0.6], width [0.16], outline ['lance'], tip, tipShape, cup [25], curl [-25], curlPower [1.4], flare [0], twist [12], ruffle [0.003], ruffleFrequency [6], ruffleDepth [0.35], midrib [-0.004], thickness [0], thicknessTip [0.4], baseColor, tipColor, segments [[28, 48]], seed }`: the same op as `petal` with a leaf's defaults: a lance outline, a gentle arch back, a groove down the middle, a slight twist, and no tone (give `baseColor` and `tipColor` for one).
  A blade of grass is a leaf too: `{ "op": "leaf", "length": 0.3, "width": 0.0075, "cup": 35,
  "curl": -30, "twist": 25, "ruffle": 0, "segments": [4, 16] }`, copied onto points (`scatter`, `copyToPoints` with `align: "up"`).
- `flowerHead { petals [3], layers [2], open [0.3], petal: { ... }, coverage [0.92], inner [0.9], lag [0.3], openAngle [58], openCup [55], mouth [0.62], jitter [0.5], seed, frames [8], center [true] }`:
  - It is petals around +Y on the origin. `petals` is per layer, so the default is a tulip's six tepals in two whorls of three.
  - Closed, each layer's petals meet on one egg-shaped surface (`coverage` of a full turn), and each inner layer (`inner` its size)
    nests inside and turns half a step. `mouth` is how far the top draws in, as a share of the widest. `petal` takes any petal param;
    the petal's params may also stand on the head itself (`width`, `ruffle`, `flare`...), which is where the Nodes panel writes them.
  - Its opening is the shape key `open`, 0 a closed bud to 1 wide open, in `frames` in-betweens. Inner layers open later by `lag`,
    petals lean out to `openAngle` and flatten their cup to `openCup`. Play it with the object's `keys: { "shape:open": [...] }`:
    a bloom costs no rebuild.
  - `center` adds a pistil and a ring of stamens on material slot 1 (`"materials": ["petal", "centre"]`).
  - No two petals alike: `jitter` (0 to 1) and `seed` vary each petal's length (so the tips stand at different heights, ±10 % at the
    default 0.5), width (±6 %), turn, lean and twist (a few degrees), the cup of one side and the tone (its colours ±4 % lighter or
    darker and ±2 % warmer or cooler, so the petals of one flower photograph a shade apart); and half the petals wear their material's
    pattern mirrored across, so a `veins` petal's veins are not one petal's printed on all of them. Outer petals only lean out and loosen,
    inner ones only lean in and tighten, so none passes through another. The petals lean out at the top by 16 degrees (`flare`).
  - A petal built elsewhere comes in through `in: "#id"`, swung open about its base.
- `stem { path [[[0, -0.6, 0], [0.004, -0.3, 0.025], [0, 0.012, 0]]], radius [0.014], taper [0.85], profile, receptacle [0.044], receptacleLength [0.07], bend [8], toward ['z'], radial [16], segments, tension [0.5], caps [true], ribs [0], ribDepth [0.04] }`:
  a closed tube that thins from `radius` to `taper` of it at the top (or follows `profile`, shares of `radius` base to top), then swells
  smoothly into a domed receptacle `receptacle` wide over its last `receptacleLength`: the bulge a flower's petals grow from, as wide as
  the default flower head's ring of petals. `receptacle: 0` leaves it out. `bend` curls it that many degrees more toward `toward`,
  keeping its top where the path ends, so a stem from the default path stands right under a head at the origin. `ribs` long ridges run
  up it, `ribDepth` of its radius high, fading out into the receptacle (a tulip's stem 6 to 8 at 0.03 to 0.05: it is not a turned rod).
  It writes `group:along`. `tube` with `taper` and `bend` also makes a stem, without the receptacle.

- `drops { count [40], radius [[0.0006, 0.003]], contact [110], flatten [0.3], lean [0.5], up [0.15], side ['up'], gap [0.1], sink [0.1], wobble [0.3], mask, segments [20], seed [0] }`: water drops resting on the input surface (dew on a petal or a leaf, rain beading on a car, condensation on a bottle), as their own mesh in the input's space.
  Make them an object of their own with a water material, in the same place as the surface (`in: "@petals"`
  brings that object's mesh in its own space, so give the drops object the same `at`, `rot` and `scale`).
  - Each drop is a spherical cap meeting the surface at `contact` degrees (a waxy petal or a water-repellent leaf 100 to 150,
    glass 20 to 60; past 90 it bulges out over its own footprint), give or take 8. `radius` is the footprint's radius in metres: a pair
    gives a range, small drops far more common than big ones, as dew forms; no two overlap (`gap` is the space between them as a share of
    their radii), and none hangs over the surface's open edge (a petal's rim, a blade's side).
  - Gravity: drops near water's capillary length (2.7 mm) and bigger slump flatter by `flatten` (0 none, 0.9 a puddle), and on a slope
    they lean and run downhill by `lean`. A drop pinned on a real surface is not a perfect circle: `wobble` (0 to 1) bends its contact
    line in two or three soft lobes (0: a lens-perfect bead).
  - Where: `side` `"up"` puts each drop on whichever face of the surface looks up (a sheet's normals may point either way), `"out"` on
    the side its normals point to, `"in"` on the other; `up` (-1 to 1) is how far that side must look up (0.15: not on steep faces;
    -0.5: on near-vertical petals too, as dew sits on everything; -1: hanging under a leaf as well). `mask` is an expression over `P`,
    `N`, `uv` (as `scatter`'s) for where they may sit.
  - A drop is open at its foot: the surface it rests on is its other side, as a real drop's is, and its rim sits `sink` of its radius into
    the surface, so no film of air shows between drop and petal on a curve. So the light that comes through a backlit petal or leaf
    goes on into the drops on it (a closed base would stand behind the sheet as a thin slab of water and keep that light out). A cap is an
    open mesh, so give the water `thinWalled: false` (a body, not a film): `{ "transmission": 1, "ior": 1.333, "roughness": 0,
    "thinWalled": false }`: each drop is then a little lens that shows the scene
    behind it upside down and, in Final, throws a caustic onto the surface under it. About 400 triangles a drop at `segments` 20.

**Thin, glowing edges.** A material's translucency can follow a group:
`{ "translucency": 0.9, "translucencyInner": 0.5, "translucencyAttr": "group:thick", "doubleSided": true }`. Each point gets `translucency`
where the group is 0 (the petal's thin rim and tip) and `translucencyInner` where it is 1 (its thick base), so the edges let more light
through when lit from behind, in Draft and Final. The share rides in the mesh's colour alpha, which the material reads as vertex colours.

**Veins.** The procedural pattern `veins` draws a petal's or a leaf's veins over the sheet's own uv (u across, v base to tip: one uv tile
is one whole petal or leaf, so keep its `scale` at 1):
- `kind: "petal"`: `count` [26] fine veins across the base that run to the tip, meander (`wander` [0.6]) and fork as the petal widens
  (`fork` [1], 0 never); in the world they fan out from the base and draw together at the tip, as a real petal's do. `vary` [0.5]: how
  unevenly they are spaced and how unlike in strength (a few strong among many faint; 0 even and alike reads as printed lines). `kind: "leaf"`: a
  midrib, `count` [26; 10 to 16 reads as a leaf] side veins each side at `angle` [50] degrees that arch toward the tip near the rim
  (`aspect` [3.5], the leaf's length over its width, keeps that angle true in the world), and a fine net between them (`net` [0.25]).
- `colors`: the sheet's ramp from base to tip (`along` [0.6] how much it follows the length; `blotch` [0.5] soft patches of tone), then
  the vein colour last: a petal's veins a deeper, more saturated shade of the petal, a leaf's paler than its green (a leaf with no
  `colors` is green). `contrast` [0.55] how strongly the veins take it, `bleed` [0.45] how far it spreads into the sheet beside them (the
  pigment that gathers along veins). The veins are a faint groove and a little smoother than the sheet (`roughness` [[0.32, 0.45]]).
- `wear` [0] (0 to 1): a real petal's or leaf's wear: a ragged browned rim (wider toward the tip), soft water-soaked bruises and faint
  creases where it was folded in the bud, in colour, roughness and relief. 0.2 to 0.4 for a fresh cut flower: a sheet with none reads
  as printed.
- It bakes once, 1024 a side by default (`size` 2048 for a petal that fills the frame; about 0.2 s at 1024). The petal op's tone
  (`baseColor` to `tipColor`) multiplies it, and with `translucencyColor` left out the light through a backlit petal takes the veins'
  colours: the veins show dark and rich against the glow, the way a backlit petal photographs.

A tulip, lit from behind:

```json
"materials": {
  "petal": { "procedural": { "pattern": "veins", "colors": ["#f8f0e2", "#efe2c8", "#e6d6ba", "#c9b48a"], "size": 2048 },
             "translucency": 0.9, "translucencyInner": 0.5, "translucencyAttr": "group:thick", "sheen": 0.35, "doubleSided": true },
  "water": { "transmission": 1, "ior": 1.333, "roughness": 0, "thinWalled": false },
  "centre": { "base": "#b9a64e", "roughness": 0.6 },
  "stem": { "base": "#5e7d36", "roughness": 0.5 }
},
"lights": [{ "id": "back", "type": "sun", "dir": [-0.35, 0.42, -1], "color": "#ffd9a8", "intensity": 5, "size": 3 }],
"objects": [
  { "id": "tulip", "material": "petal", "materials": ["petal", "centre"],
    "graph": [{ "op": "flowerHead" }, { "op": "sculpt", "strokes": [{ "brush": "crease", "path": [[0.03, 0.27, 0.6], [0.045, 0.36, 0.6]], "project": [0, 0, -1], "radius": 0.035, "strength": 0.35 }] }],
    "keys": { "shape:open": [{ "t": 0, "v": 0.05 }, { "t": 3, "v": 0.6 }] } },
  { "id": "stem", "material": "stem", "graph": [{ "op": "stem" }] },
  { "id": "dew", "material": "water", "graph": [{ "op": "drops", "in": "@stem", "side": "out", "up": -0.9, "count": 8, "radius": [0.002, 0.005] }] }
]
```

Drops on a flower that opens on a key sit where its shown pose (`open`) puts the petals; they do not follow the opening, so give dew to a
flower that holds still (or move the camera instead). The whole macro shot of this kind, a backlit tulip with dew in a meadow at sunrise,
is tests/flower/hero.mjs in the app's repository.

### Rooms and furniture

Sources that build a room from its floor plan and furniture from parts, with their sizes as numbers. Each gives one mesh whose triangles are in named material slots: list the materials on the object in that order (`"materials": [...]`), or take one slot alone with `part` (then the object wears `material`), or several with a list (`"part": ["pot", "soil"]`: those slots kept, `materials` still in the op's full order). Vertex colours (books, leaves) show only on an object with one material. Their uvs are in metres (box projection), so smart materials keep their real size. Furniture faces +z and stands on y = 0; turn it with the object's `rot`.

- `room { plan **required**, height [2.6], thickness [0.12], openings [], skirting [0.08], cornice [0], window {}, door {}, part }`: walls with thickness round `plan` (the inner corners `[[x, z], ...]`, either way round; wall `i` runs from corner `i` to `i + 1`), the floor and ceiling inside it, skirting along the walls (broken at doors), an optional cornice, and every opening's own parts. An opening is `{ wall, at, width, height, sill, kind }`: `at` is metres from the wall's first corner to the opening's middle, `sill` its bottom above the floor, `kind` `"window"` (defaults 1.2 x 1.4 at 0.9) or `"door"` (0.85 x 2.05 at 0). The wall is cut round it, so its reveals (the wall's thickness inside the opening) are real faces. `window` sets every window's `frame` [0.055], `depth` [0.07], `mullions` [[1, 1]] (panes across, up), `glass` [0.006], `sill` [0.025], `sillDepth` [0.18]; `door` sets `casing` [0.07], `leaf` [0.04] and `open` [0] (degrees). An opening's own `window` or `door` overrides them. Slots and `part`: `walls`, `floor`, `ceiling`, `skirting`, `cornice`, `frames` (window frames and door casings), `glass`, `sills`, `doors`, `portals`. Make one object per part you want (each its own material and its own texture bake); they all take the same plan.
- `portals`: each window opening's rectangle on the room side. Final already takes a room's windows as portals while the camera is inside it, so this part is only needed to mark them by hand (an object made of it with `"portal": true`; any portal object in the scene turns the automatic ones off).
- `window { width [1.2], height [1.4], thickness [0.12], frame, depth, mullions, glass, sill, sillDepth, part }` and `door { width [0.85], height [2.05], thickness, casing, leaf, open, part }`: one alone, its bottom middle at the origin, the wall's inner face at z = 0 and the room toward -z. Window slots: `frames`, `glass`, `sills`, `portal`; door slots: `casing`, `leaf`.
- `curtain { width [1.4], height [2.4], pleats [7], fullness [1.8], wind [0], steps [120], rail [true], natural [0], seed, part }`: a curtain gathered into pleats on a rail at y = `height`, let fall and settled by the cloth solver with its top held (about half a second); `wind` blows it sideways (+x) while it settles; `steps: 0` hangs it unsettled, in even folds with a straight hem (a sheer cafe curtain on the lower panes). `natural` (0 to 1; 0.7 to 0.9 for a lived-in room) hangs it as cloth really hangs: the heading gathered into tight even pleats at the rail, the folds below of their own widths and depths, opening out and wandering toward a heavier turned-up hem, the leading edge swung back a little. Slots: `cloth`, `rail`. Give the cloth `doubleSided: true` (and a little `translucency` for linen against a window).
- `sofa { width [2.0], depth [0.9], height [0.8], seat [0.43], arms [0.16], back [0.2], cushions [3], legs [0.1], softness [0.045], lived [0], part }` and `armchair { ... }` (the same, 0.88 wide, one cushion): plinth, arms with a welt round their front panels, boxed seat cushions with a dent where people sit and stuffed back cushions leaning back (all piped), short legs. `lived` (0 to 1) is a sofa people sit on: softer seat cushions sagging deeper, each its own way, crowned and creased where people sit, piped, the back cushions slumped, and the arms' tops and fronts and the seats' front edges a shade lighter where they are rubbed (0.6 to 0.9 for a lived-in room). The rubbed parts are vertex colours, which show on an object whose upholstery is its only material: make the upholstery its own object (`part: "upholstery"`) and the legs another (`part: "legs"`). Slots: `upholstery`, `legs`.
- `cushion { width [0.45], height [0.45], thickness [0.15], sag [0], piping [0], slump [0], creases [0], seed, part }`: a stuffed cushion: plump in the middle, thinning to a seam all round, its edges drawn in between pointed corners, faint creases from the corners, each `seed` a little uneven. `sag` (metres) presses a dent into its +z face where someone sat; `piping` (a radius, 0.003 to 0.006) runs a corded welt along the seam; `slump` (0 to 1) gives it weight, as a scatter cushion leaning on a sofa's back: its top flops forward with a soft crease across its front, its foot spreads and flattens (0.4 to 0.8 reads as a real cushion); `creases` (0 to 1) wrinkles its +z face where it was sat on: a few shallow valleys fanning round the dent and pulled toward its -y edge. It lies in x/y facing ±z, its middle at the origin: stand it on a sofa with the object's `at` and lean it back with `rot` [-15, 0, 0]; lay a seat cushion flat with `rot` [-90, 0, 0]. The sofa's own seat and back cushions are these (seats with a dent, all piped). Slot: `cushion`.
- `throw { width [0.8], length [1.6], thickness [0.008], over [0.16], height [0.62], inside [0.2], folds [5], drop [0.12], fringe [0], seed, part }`: a heavy throw (a wool blanket) dropped over a sofa's arm: across the arm's top (`over` wide, its top `height` above the floor), `inside` metres down the inner face toward the seat and the rest down the outer face, in soft heavy folds that grow from nothing where it rests on the arm to their full depth at the hem, the hem `drop` metres lower at one side than the other; every `seed` folds it its own way, with a real `thickness` all round. The arm runs along z (`width` no more than the arm is deep), its top's middle at x = 0, y = `height`, the seat toward -x: put the object's `at` at the arm's middle on the floor ([sofa x + width / 2 - arms / 2, 0, sofa z] for a sofa's right arm; `rot` [0, 180, 0] for the left one), `height` = the sofa's `height` × 0.78, `over` = its `arms`. Give it a knitted `fabric` and `doubleSided`. `fringe` (metres, 0.03 to 0.08) hangs tassels from both hems, each its own length and a little askew. Slot: `throw`.
- `coffeeTable { width [1.1], depth [0.6], height [0.42], top [0.03], leg [0.04], round [false], shelf [0], part }` and `diningTable` (1.8 x 0.9 x 0.75): a top on four tapered legs; `round: true` makes it a disc `width` across; `shelf` a lower shelf at that height. Slots: `top`, `legs`.
- `chair { width [0.45], depth [0.5], seat [0.46], height [0.84], leg [0.032], part }`: a wooden chair, its back at -z. Slots: `seat`, `frame`.
- `shelf { width [0.8], depth [0.3], height [1.8], shelves [5], board [0.022], back [true], books [0.75], palette ['bold'], spines ['simple'], seed, part }`: an open bookcase; `books` (0 to 1) fills its shelves with books of their own size and colour (`palette: "muted"`: a real shelf's spines, mostly white, cream and black paperbacks and faded cloth, a few colours; `"library"`: a lived-in shelf's mix, a third white and cream paperbacks, the rest dark cloth and jackets (navy, black, oxblood, bottle green, slate) with a few ochres and greys; `"bold"` saturated cloth colours): two cover boards proud of a cream page block (seen from above), a spine with a title band or label on many, a few lying flat in stacks, one leaning on the end of a row. `spines: "real"` builds the books as a shelf holds them, for a room that has to pass as a photograph: real sizes (paperbacks, trade books, hardcovers and a few tall art books, runs of a series alike), spines toward the room a little in and out, a hardcover's rounded back with a coloured headband at head and tail and its boards proud of the pages, a paperback's flat back, the cloth worn lighter at the head, tail and hinges, and the lettering as type sets it: the title running down the spine in words of letters of their own widths, the author's name smaller below, a publisher's mark at the foot (a wide spine: the title across it), light on dark books, dark on light ones, gilt on some cloth; bigger books stacked flat at a row's end. The books carry vertex colours, which show on an object with one material: make the books their own object (`part: "books"`, a white `base` or a graph) and the boards another (`part: "boards"`). An object with `materials` wears no vertex colours, so its books would all be one colour. Slots: `boards`, `books`.
- `lamp { kind ['floor'], height [1.55], shade [[0.17, 0.22, 0.26]], base [0.14], stem [0.012], part }`: a floor lamp, or `kind: "table"` (0.55 high, a turned base). The shade is an open, thin cone (top radius, bottom radius, height): give it `translucency` 0.5 to 0.8 and `doubleSided`, and put a `point` light at its middle (y = height - shade height / 2). Slots: `body`, `shade`, `bulb`.
- `rug { width [2.0], depth [1.4], thickness [0.012], round [0.02], border [0], ripple [0], curl [0], pile [0], fringe [0], seed, part }`: a rug; `border` (metres) binds its edge with a band a little proud of the pile (slot `border`), `ripple` (metres, 0.003 to 0.008) lifts it in a few soft waves and `curl` (0.01 to 0.04) lifts its +x +z corner, as a rug that is walked on lies. `pile` (metres, 0.008 to 0.02 for a hand-knotted wool rug) stands a deep pile on it: its top lumpy where the tufts lean together, rolled down over a ragged edge that wanders a few millimetres. `fringe` (metres, 0.04 to 0.1) knots the warp's ends into tassels at its two short ends, lying on the floor each a little askew (slot `fringe`: give it a plain off-white wool, e.g. `fabric: { "weave": "knit", "threads": 900 }`). Slots: `rug` (the `woolRug` preset; `pattern: "lattice"` is the hand-knotted diamond lattice, and its `hand` (0 to 1, 0.6 to 0.8 for a real one) makes the lines wander further, swell, thin and fade here and there, and the ground drift in soft bands of dye, an abrash), `border`, `fringe`.
- `plant { pot [0.13], potHeight [0.26], height [0.55], leaves [11], stems, leafLength [0.24], leafWidth [0.09], droop [0.5], leaf {}, kind ['leafy'], seed, part }`: a pot with soil and a leafy plant: `stems` (about one per five leaves when left out) rise from the soil leaning out, with `leaves` on short stalks along their upper part, turning round each stem, larger and drooping more (`droop` 0 to 1) lower down, upright at the tip. `leaf` takes the `leaf` op's params (`outline: "oval"`, `ruffle`, `cup`...). The leaves carry colours (vertex colours): each leaf a shade of `leafColor` [[0.1, 0.22, 0.06], linear], young ones at the tips lighter, a paler midrib, a dry brown tip on `browning` [0.2] of the old ones. They show on an object of the leaves alone with a white material (`part: "leaves"`, `"base": "#ffffff"`, a green `translucencyColor`); the rest as a second object with `part: ["pot", "soil", "stems"]` (a list keeps those parts and their slots, so `materials` still lists all four). A floor plant is 30 to 50 leaves on 3 stems at 1.2 to 1.5 m; a sill plant 15 small ones on 5. `kind: "fig"` is a fiddle-leaf fig: leathery leaves wider toward their tip with a waist below, a sunken midrib and pale lateral veins (colours), a wavy edge, on stout petioles that arch up from the branch and bend down into the blade, and woody branches as thick as a thumb at the soil (give `stems` a bark brown); leave `leaf` out for its own leaves (what `leaf` sets wins; they are single sheets: a leaf with `thickness` takes a window's light through two faces and comes out much darker in Final). Use the same `kind` on both of the plant's objects. Slots: `pot`, `soil`, `leaves`, `stems`. Leaves want `translucency` 0.3 and `doubleSided`.
- `pictureFrame { width [0.5], height [0.7], frame [0.035], depth [0.025], mat [0.05], upright [false], part }`: a frame with a mat and a picture, hanging from its back at z = 0 and facing +z. The picture's uv runs 0..1 across it (an image map, or a graph). For an image map give `upright: true`: the image then reads as drawn, seen from the front; without it the picture's v runs bottom to top and an image map shows upside down (the same as `uvScale [1, -1], uvOffset [0, 1]` on its material undoes). Slots: `frame`, `mat`, `picture`.

A whole room (one object per part; the window's daylight from the scene's sun and the environment, whose sky is seen through the window: `"opaque": true`, or the layers under the Scene show through the glassless opening; the window is Final's portal by itself):

```json
"materials": {
  "plaster": { "graph": { "preset": "paintedPlaster", "color": "#ece9e3" } },
  "oak": { "graph": { "preset": "oakBoards" } },
  "white": { "base": "#efede8", "roughness": 0.45 },
  "linen": { "graph": { "preset": "linen" }, "doubleSided": true, "translucency": 0.45, "fabric": { "threads": 300 } },
  "pane": { "pane": true },
  "fabric": { "graph": { "preset": "wornFabric", "color": "#b7b4ae" }, "fabric": { "weave": "basket", "threads": 300 } },
  "furniture": { "graph": { "preset": "lacqueredWood" } },
  "rug": { "graph": { "preset": "woolRug", "pattern": "diamonds" }, "fabric": { "weave": "pile", "threads": 420 } },
  "shade": { "graph": { "preset": "linen" }, "translucency": 0.7, "doubleSided": true },
  "mustard": { "graph": { "preset": "velvet", "color": "#c4952f" } },
  "black": { "base": "#1d1d1f", "roughness": 0.42, "metalness": 0.9 },
  "bulb": { "base": "#fff4e0", "emission": "#ffd9a0", "emissionStrength": 6 },
  "pot": { "graph": { "preset": "glazedCeramic", "color": "#e8e4dc" } },
  "soil": { "base": "#3a2e25", "roughness": 0.95 },
  "leaves": { "base": "#3f6a34", "roughness": 0.55, "translucency": 0.3, "doubleSided": true },
  "stems": { "base": "#4b6b35", "roughness": 0.6 }
},
"objects": [
  { "id": "walls", "material": "plaster", "graph": [{ "op": "room", "plan": [[-2.3, -2.7], [2.3, -2.7], [2.3, 2.7], [-2.3, 2.7]], "height": 2.7, "thickness": 0.14,
      "openings": [{ "wall": 3, "at": 3.05, "kind": "window", "width": 1.9, "height": 1.65, "sill": 0.62 }], "window": { "mullions": [2, 1] }, "part": "walls" }] },
  { "id": "floor", "material": "oak", "graph": [{ "op": "room", "plan": [[-2.3, -2.7], [2.3, -2.7], [2.3, 2.7], [-2.3, 2.7]], "height": 2.7, "part": "floor" }] },
  { "id": "frames", "material": "white", "graph": [{ "op": "room", "plan": [[-2.3, -2.7], [2.3, -2.7], [2.3, 2.7], [-2.3, 2.7]], "height": 2.7, "thickness": 0.14,
      "openings": [{ "wall": 3, "at": 3.05, "kind": "window", "width": 1.9, "height": 1.65, "sill": 0.62 }], "window": { "mullions": [2, 1] }, "part": "frames" }] },
  { "id": "glass", "material": "pane", "graph": [{ "op": "room", "plan": [[-2.3, -2.7], [2.3, -2.7], [2.3, 2.7], [-2.3, 2.7]], "height": 2.7, "thickness": 0.14,
      "openings": [{ "wall": 3, "at": 3.05, "kind": "window", "width": 1.9, "height": 1.65, "sill": 0.62 }], "window": { "mullions": [2, 1] }, "part": "glass" }] },
  { "id": "curtain", "material": "linen", "materials": ["linen", "white"], "at": [-2.12, 0, 0.95], "rot": [0, 90, 0], "graph": [{ "op": "curtain", "width": 0.75, "height": 2.45, "pleats": 6, "fullness": 2 }] },
  { "id": "sofa", "materials": ["fabric", "furniture"], "material": "fabric", "at": [-0.25, 0, -2.23], "graph": [{ "op": "sofa", "width": 2.1, "cushions": 3 }] },
  { "id": "rug", "material": "rug", "at": [-0.2, 0, -0.55], "graph": [{ "op": "rug", "width": 2.3, "depth": 1.6 }] },
  { "id": "table", "material": "furniture", "at": [-0.2, 0.012, -0.85], "graph": [{ "op": "coffeeTable", "width": 0.82, "round": true }] },
  { "id": "shelf", "material": "furniture", "at": [1.55, 0, -2.54], "graph": [{ "op": "shelf", "width": 0.9, "height": 1.95, "books": 0.8, "part": "boards" }] },
  { "id": "books", "material": "white", "at": [1.55, 0, -2.54], "graph": [{ "op": "shelf", "width": 0.9, "height": 1.95, "books": 0.8, "part": "books" }] },
  { "id": "cushion", "material": "mustard", "at": [-0.95, 0.68, -2.15], "rot": [-16, 8, 4], "graph": [{ "op": "cushion", "width": 0.46, "height": 0.46 }] },
  { "id": "lamp", "materials": ["black", "shade", "bulb"], "material": "black", "at": [-1.55, 0, -2.05], "graph": [{ "op": "lamp", "height": 1.58 }] },
  { "id": "plant", "materials": ["pot", "soil", "leaves", "stems"], "material": "pot", "at": [-1.75, 0, 1.0], "graph": [{ "op": "plant", "pot": 0.17, "potHeight": 0.34, "height": 1.35, "leaves": 40, "stems": 3, "leafWidth": 0.15, "leaf": { "outline": "oval" } }] }
],
"env": { "background": "env", "opaque": true },
"lights": [
  { "id": "sun", "type": "sun", "dir": [-0.86, 0.42, -0.29], "intensity": 4.2, "color": "#ffe9cf", "size": 0.8 },
  { "id": "bulb", "type": "point", "at": [-1.55, 1.42, -2.05], "intensity": 0.6, "color": "#ffc98a" }
]
```

(The frames repeat the walls' plan and openings: each object builds its own part of the same room.) The whole scene is tests/rooms/scandi.mjs in the app's repository.

Light a room as one day. The sky seen through the window and the light inside must agree: a sun light needs a sky preset with its own sun in the same direction (and sunlit things outside); an overcast preset (`forest_slope_1k`, `potsdamer_platz_1k`) goes with no sun light at all, the room lit by the sky through its openings and falling off from them. The view out of the window is the preset itself, blurred at 1k, unless `env.view` gives it a picture (a photo of the street: sharp at its own resolution, the room still lit by the preset); with no picture, a garden or trees read better than a street. Glaze the windows with a `pane` (the room op's `glass` part): the light still comes in and the glass reflects the room faintly. Leave Final's `clamp` off in a room (it takes the bounced light's energy: a darker, blotchy picture). A `room` op's windows are portals by themselves while the camera is inside the room; a room built from boxes needs a `portal: true` object in each window, so the sky's light converges.

### Escape hatch

- `script { code **required**, seed [0] }`: a JS function body that receives `(input, ops, ctx)` and returns a Geo or a MeshData (shapes below). `input` is the first input as a Geo. `ops` has every op above: `ops.box({ size: 1 })`, `ops.twist(geo, { amount: 30 })`, `ops.boolean(a, b, { mode: 'subtract' })`, `ops.merge([a, b])`; inputs first, params last, each returning a Geo. `ctx` has `inputs`, `params`, `seed`, `makeMesh({ position, index })`, `rand(i, stream)`, `noise(x, y, z)`. Same shadowed globals as `attrib`. Reach for it only when the ops above cannot say it.
  - **Parameters:** every field of the node other than `op`, `id`, `in`, `sources`, `note` and `bypass` arrives in `ctx.params`, as written. Keep the data there rather than inside `code`: the node is cached by its fields, and the editor shows them. `{ "op": "script", "code": "const { rows, gap } = ctx.params; …", "rows": 5, "gap": 0.02, "palette": ["#b04a3a", "#2f5d8a"] }` gives `ctx.params.rows` 5.
  - **Colours:** an instance colour (`instances[].colors`, 3 numbers per copy) and a mesh's vertex colours (`mesh.color`) are LINEAR RGB, 0 to 1, and they multiply the material's `base` and maps: leave `base` white to see them as given. From a hex colour `#rrggbb`, each channel c = value / 255 becomes c / 12.92 when c ≤ 0.04045, else ((c + 0.055) / 1.055) ^ 2.4: `#b04a3a` is [0.434, 0.068, 0.042]. `Cd` written by `attrib` and carried by `copyToPoints` is the same.

```js
Geo = {
  mesh: MeshData | null,          // triangles
  points: PointSet | null,        // from scatter and point ops
  instances: [{ source: MeshData, matrices: Float32Array /* 16 per copy */, colors: Float32Array | null /* 3 per copy */ }]
}
MeshData = { position: Float32Array, normal: Float32Array, uv: Float32Array, index: Uint32Array }
PointSet = { count, P: Float32Array, N: Float32Array, pscale: Float32Array, orient: Float32Array /* xyzw */, Cd: Float32Array, id: Uint32Array, ...custom }
```

In the editor, `attrib`, `script` and string masks run in an isolated evaluator: an opaque-origin frame with no network, no storage and no way to see the page, stopped after 20 seconds. They can compute anything and reach nothing, so they cannot fetch, and everything they need arrives through `input`, `ops` and `ctx`.

## Lights in the scene

`rig.scene.lights[]` are lights in metres, in the same space as the objects. Each has an `id` (unique: keys and the critique name it),
a `type`, `color` (sRGB, or a colour temperature such as `"3200K"`) [`#ffffff`], `intensity` [1] and `castShadow` [true]. The `type` decides which other fields it reads, and a
field of another type is ignored (the validator says so):

| type | Where it is and where it points | Size and shape | `intensity` |
|---|---|---|---|
| `sun` | `dir` [[0.4, 1, 0.3]]: points FROM the set TOWARD the sun (any length). `[0, 1, 0]` noon overhead; y below 0 lights from underneath. Parallel rays everywhere. | `size` [1]: degrees across the sky; 0.5 the real sun (crisp shadows), 2 to 5 hazy. | Irradiance, Blender's Sun Strength: 1 to 4 daylight. |
| `area` | `at` [[0, 2, 0]]: the panel's centre. `target` [[0, 0, 0]]: the point it faces. It lights only the side facing `target`. | `width`, `height` [1, 1] metres: `width` lies level (horizontal), `height` along the panel's up; `circular: true` makes it a disc `width` across; `spread` [180] degrees narrows its cone (a softbox grid). | The panel's radiance (light leaving it straight out), so its light is intensity × area: halve the width and double the intensity for the same light. A 0.5 m panel about 1 m from the subject: 3 to 10. Twice the distance needs four times the intensity. |
| `spot` | `at` [[0, 2, 0]]: the lamp. `target` [[0, 0, 0]]: what it points at. | `angle` [30]: HALF the cone, degrees. `penumbra` [0.3]: soft edge 0 to 1. `radius` [0]: bulb size in metres (softer shadows). | Candela-like, falling off with distance squared: 1 to 5 for a lamp about 0.5 m away. |
| `point` | `at` [[0, 2, 0]]: the bulb; it shines every way. | None: a point light has no size, so its shadows stay hard (`radius` does nothing on it). For a soft little lamp use a small `area` with `circular: true`, or a `spot` with `radius`. | As a spot. A candle flame: 0.1 to 0.3, warm (`#ffb35c`). |

```json
"lights": [
  { "id": "key", "type": "area", "at": [-0.6, 0.7, 0.6], "target": [0, 0.12, 0], "width": 0.6, "height": 0.6, "intensity": 6 },
  { "id": "rim", "type": "spot", "at": [0.5, 0.6, -0.7], "target": "@bottle", "angle": 20, "penumbra": 0.5, "intensity": 4 },
  { "id": "sun", "type": "sun", "dir": [-0.5, 0.6, 0.4], "intensity": 2, "size": 1.5 }
]
```

`at` and `target` take numbers or an object to follow (`"@bottle"`, below). A fifth type, `studio`, is a ready set of lights sized to a
subject ([Studio presets](#studio-presets-type-studio)); `highlight` places a light by where its reflection must land
([below](#put-the-highlight-where-you-want-it-highlight)).

- Classic product light: a big `area` key 30 to 60 degrees to one side of the camera and a little above, aimed at the subject; a `spot`
  or a strip `area` behind the subject for a rim on glass edges; the environment low (0.1 to 0.3) for fill. A key standing right behind
  the camera lights the subject flat. The still's critique says where each light stands against the shot ([Check your work](#check-your-work)).
- `spread` in degrees on an `area`. `intensity` is the light leaving the panel straight out, so a narrow spread keeps its power only if you raise it by `tan(h) / (tan(h) - h)`, where `h` is half the spread in radians. That is how a Blender light comes across.
- `texture: { "image": url }` or `{ "pattern": "window" }` (or `blinds`, `leaves`) on a `spot` or `area`: the spot projects it, the
  panel wears it. In Draft and Final alike a panel's picture lights each point with the part of it that point sees: the floor under a
  stained-glass panel takes each pane's colour, and a glossy surface reflects the picture. `gobo: { "pattern" | "image", "distance", "scale", "rotation", "extent" }` on any light puts real geometry between it
  and the set, out of frame, so the shadow carries the pattern.
- `castShadow: false` on any light: it lights but throws no shadow.
- Scene lights have no `parent` and no `keys`. To follow an object, name it: `"target": "@bottle"` aims a `spot` or `area` at the
  middle of that object's box, `"at": "@bulb"` puts the light there, and `{ "object": "bottle", "point": [0, 0.12, 0] }` names a point
  in the object's own space (its `at`, `rot` and `scale` apply). A light that names an object is placed again on every frame the object
  moves (its keys, a body that falls), in Draft and Final.
- A light inside a closed object (a bulb in its glass, a point light in a candle's flame) is shut in by it: give that object
  `castShadow: false` so the light gets out. In Final a point light inside a closed glass jar does light the table through the glass.
- A light itself is never drawn: a panel or a bulb inside the frame is invisible to the camera, in Draft and Final. Glossy surfaces
  and glass reflect an `area` panel in Final (the long highlight of a strip softbox on a bottle). To see a lamp, model it and give it
  `emission`.
- Light from a glowing surface (a screen, a bulb's glass) is the material's `emission` ([glowing surfaces](#glowing-surfaces)).

### Light in a lighting designer's units: `kelvin`, `power`, `lumens`, `ies`

```json
"lights": [
  { "id": "bulb", "type": "point", "at": [0, 1.9, 0], "kelvin": 2700, "power": 60 },
  { "id": "down", "type": "point", "at": [-0.8, 2.4, -0.3], "ies": "downlight", "color": "3000K", "lumens": 900 },
  { "id": "wash", "type": "point", "at": [0, 2.4, -0.35], "ies": "/media/…/wallwasher.ies", "iesRotation": 90 },
  { "id": "accent", "type": "spot", "at": [1, 2.4, 0], "target": "@vase", "ies": "spot", "intensity": 6 }
]
```

- Colour temperature: `kelvin` (800 to 40 000) or `color: "3200K"`: the colour of a black body at that temperature, the same as
  Blender's Blackbody, with luminance 1, so `intensity` still says how bright. 1900 a candle, 2700 a warm bulb, 3200 tungsten, 4000 a
  cool white LED, 5600 daylight, 6500 overcast. With both, `color` tints the temperature's colour.
- `power` in watts as Blender counts them (a Blender light's Power carries over as it is): a `point` or `spot` gives power / 4π per
  steradian (`intensity` = power / 12.57), an `area` panel's radiance is power / (π × its area). `lumens` at Blender's 683 lumens per
  watt. `intensity` wins when both are given; a `sun`'s `intensity` is already W/m². Real bulbs are dim at the default exposure (an 800 lm
  bulb is intensity 0.09, where a lamp in a product shot is 1 to 5): raise `exposure` as a camera would indoors, or use `intensity`.
- `ies` on a `point` or `spot`: a luminaire's measured light by direction (an IES LM-63 file: its media URL, or `{ "text": "<the file>" }`),
  or a preset: `downlight` (a recessed downlight's wide cone cut off at about 60°), `spot` (a tight 12° beam with a faint halo), `flood`
  (a broad beam to about 50°), `wallwash` (thrown to one side, up a wall), `batwing` (an office troffer, brightest about 35° off the axis),
  `pendant` (mostly down, a soft glow up). The profile is the beam: a spot's `angle`, `penumbra` and `radius` no longer apply. Its axis
  (the profile's 0°) points at `target` (a `point` without one: straight down). `iesRotation` (degrees) turns it around the axis; aimed
  straight down its C0 plane points along +z and C90 along -x, as in Blender, so a file lights the same here and there. Brightness:
  `intensity` is the profile's brightest direction; `power` or `lumens` its whole light; none of them, a file's own candela (÷ 683). In
  Draft and Final alike (measured against Cycles' IES texture: within 1 level of 255 in Final); its shadow is a point light's.

### Put the highlight where you want it: `highlight`

On a glossy object the bright reflection of a light (the highlight) moves when the light moves. Say where it must land and the light
is placed for it: on the mirror direction from the surface there (the half-way vector between the camera and the light is the
surface's normal), corrected for the material's roughness, `distance` metres out, aimed at the point. It works on `area`, `spot`,
`point` and `sun` (a sun gets its `dir`), and replaces their `at` and `target`. It is solved again when the object or the camera moves.

```json
{ "id": "kicker", "type": "area", "width": 0.08, "height": 0.4, "intensity": 30,
  "highlight": { "object": "bottle", "screen": [0.56, 0.38], "distance": 0.7 } }
```

- `screen`: where in the rendered picture, [u, v] from its top left (0 to 1), through the camera that films the Scene (the Camera layer, or
  `scene.camera`; at the project's own frame: `videoSize`); the camera's ray there must meet the object. Or `point`: a point in the
  object's own space; the surface point the camera sees nearest it is used.
- `distance` [the light's own `at` distance, else 2.5 times the object's size]: further is a smaller, crisper highlight from the same
  panel; a bigger panel (`width`, `height`) is a bigger, softer one. The panel stands where the solve puts it, and nothing moves it out
  of the way: keep it smaller than its distance, and check with the still's `critique.lights` (each light's place as built, a studio
  preset's parts too) that the floor or another object does not stand in front of it.
- The surface's own normal there decides the reflection: pick a point on a smooth stretch, a few millimetres from a crease or a profile
  corner (a lathe profile's points are creases unless smoothed), where a small error in the point moves the normal a lot.
- The light's other fields work as on any light: its links (`lights`, `excludes`, `shadowFrom`, `shadowExcludes`) choose what it lights
  and what shadows it, and do not change where it is put.
- The highlight lands within a pixel or two of the point in Draft and Final. On a straight stretch of a round body (a cylinder's side)
  the reflection is a line along it: the line passes through the point, and where along it the brightest part falls depends on the
  panel's height. On a very rough surface (roughness 0.6 and up) it is a broad glow whose brightest pixel is less sharply placed.

### Studio presets: `"type": "studio"`

One entry stands for a whole studio set-up, sized to the subject and placed against the camera:

```json
{ "id": "studio", "type": "studio", "preset": "bottleStrip", "subject": "bottle", "intensity": 1 }
```

| `preset` | Lights (each an `area` light named `<id>.<part>`) | For |
|---|---|---|
| `threePoint` | `key` 45 degrees to one side and 30 up, `fill` big and soft on the other side (no shadow), `rim` strip behind | people, products, anything |
| `topSoftbox` | `top` a big panel overhead, `fill` low and soft in front (no shadow) | table tops, food, cosmetics, packshots |
| `rim` | `left` and `right` strips behind | outlines, dark subjects on dark |
| `bottleStrip` | `left` and `right` tall narrow strips a little behind the sides, `top` soft overhead (no shadow) | glass and glossy bottles: a clean line down each edge |

- `subject` (an object id) sizes and aims them: its box, children included. Left out: every object no wider than 2 m (floors and walls
  left out). `side` ["left"] is the key's side as the camera sees it; `distance` [1] scales how far they stand; `intensity` [1] scales
  them all (1 lights the subject as a studio would, whatever its size); `color` tints them; `castShadow`, `lights`, `excludes`,
  `shadowFrom` and `shadowExcludes` go to every part.
- Mix a preset with lights of your own (a `highlight` light for the one reflection that matters). The still's critique lists each part.

### Which light reaches what: `tags`, light linking and shadow linking

Give objects `tags` and let each light pick objects by them. The same rule holds in Draft and Final.

```json
"objects": [
  { "id": "bottle", "tags": ["hero", "glass"], "material": "glass", "graph": [ … ] },
  { "id": "backdrop", "tags": ["set"], "material": "paper", "graph": [ … ] }
],
"lights": [
  { "id": "key", "type": "area", "at": [-0.6, 0.7, 0.6], "target": [0, 0.12, 0], "width": 0.5, "height": 0.5, "intensity": 8, "lights": ["hero"] },
  { "id": "wash", "type": "spot", "at": [0, 1.4, 1.2], "target": [0, 0.3, -0.5], "angle": 30, "intensity": 6, "excludes": ["hero"] },
  { "id": "sun", "type": "sun", "dir": [-0.4, 1, 0.3], "intensity": 2, "shadowExcludes": ["glass"] }
]
```

- `lights: [tags]`: the light lights only objects with one of these tags. `excludes: [tags]`: it never lights objects with one of
  them. Both may be given; `excludes` wins.
- `shadowFrom: [tags]`: only objects with one of these tags throw this light's shadow (the light passes through the rest).
  `shadowExcludes: [tags]`: objects with one of them throw no shadow from this light, while they still shadow every other light and
  are still lit by this one. For an object that shadows no light at all, use the object's `castShadow: false`.
- A child object has its parent's tags too. An object with no tags (and the Rig's backdrop, `model3d` layers and 3D Text, which take
  no tags) is lit by a light only when that light has no `lights` list, and shadows it only when it has no `shadowFrom` list.
- A tag no object has is an `unknown_ref` error from validate (`didYouMean` names the close ones). Up to 15 lights in a scene may
  carry link fields; past that, validate warns and the extra lights light every object.
- Glossy surfaces still reflect a linked `area` panel in Final, but only surfaces it lights do.

### Light mix and light passes: `look.lightMix`, `render.lightPasses`

`rig.look.lightMix` changes each light group's strength and colour over what the lights themselves say, without touching the scene:

```json
"look": { "lightMix": { "key": { "intensity": 1.4, "color": "#ffe2c4" }, "studio": { "intensity": 0.7 }, "environment": { "intensity": 0.5 }, "emission": { "intensity": 2 } } },
"render": { "mode": "final", "spp": 64, "lightPasses": true }
```

- A group is a light's `group` (lights with one group change together), else the light's own `id`; a studio preset's parts are one
  group named by the preset's `id`. `environment` is the environment's light (not the background the camera sees) and `emission` the
  glowing surfaces; those two take `intensity` only, and `emission` changes only in Final with passes.
- Draft takes the mix at once (the lights' own numbers). A Final without passes traces again with the mixed lights.
- `"lightPasses": true` in `render`: Final keeps each light group's light apart while it traces (up to 6 groups, plus the environment and
  the glows; lights past the sixth group stay as they are), so a new mix on a finished Final is mixed and denoised again in a moment
  instead of traced again. The mixed picture is the traced one with each group's light reweighed: exact, the same as tracing the lights
  at those strengths. It needs `denoise`, turns the radiance cache and the video light reuse off for that render (a room traces slower),
  and takes 16 bytes a pixel for each group (33 MB a group at 1080p; a 4K frame keeps two light groups apart).
- A light mix is also how to try a balance: render once, then change only `lightMix`.

### What each kind of ray sees: `visibility`, `holdout`

- `visibility` on an object: `{ "camera": false }` leaves it out of the picture while it still throws its shadow and shows in
  reflections (a bounce card or a flag that must not be seen). `{ "reflection": false }` keeps it out of glossy reflections (chrome,
  glass, lacquer) while it still bounces light onto matte surfaces; `{ "refraction": false }` keeps it from being seen through glass
  and liquids; `{ "indirect": false }` takes its bounce light away and what matte surfaces bounce onto it. `{ "shadow": false }` is
  `castShadow: false`. Each is true unless set false. `camera` and `shadow` work in Draft and Final; `reflection`, `refraction` and
  `indirect` are Final's (Draft traces no such rays).
- `"holdout": true` on an object cuts a hole in the picture where the camera sees it: those pixels are see-through (alpha 0), so the
  layers below the Scene layer show there, whatever `env.background` and `env.opaque` say. The object still hides what is behind it,
  still casts its shadow and still shows in reflections, in Draft and Final. Use it to leave room for footage or another layer that
  must pass in front of part of the set. For a floor that shows only the shadows on it, use `catcher` (real 3D in footage (GreenLight Dash only)).

```json
"objects": [
  { "id": "card", "tags": ["fill"], "visibility": { "camera": false, "reflection": false }, "material": "white", "graph": [{ "op": "plane", "size": [0.6, 0.8] }, { "op": "transform", "rot": [90, 0, 0] }] },
  { "id": "doorway", "holdout": true, "graph": [{ "op": "box", "size": [0.9, 2, 0.05] }] }
]
```

### Render passes and masks: `render.passes`, `look.passMix`, world mattes

The Scene's picture split into passes, and masks of its objects, made by the Scene itself and used in the same project: no other
render, no compositing program.

- `rig.render.passes.show` makes the Scene layer show one pass instead of its picture, in the preview, stills and renders (render a
  still or a video of the project to get the pass as media):
  - light passes, Final only (Draft shows the picture): `"diffuse"` (light off matte surfaces and the diffuse part of every material,
    direct and bounced), `"specular"` (reflections, refraction through glass, a clear coat, sheen), `"emission"` (what the camera sees
    straight: glowing surfaces, lights and the background). The three add up to the picture and are filmed with its curve and `look`,
    each through the denoiser.
  - data passes, Draft and Final, shown as they are (no curve, no look, no denoiser): `"albedo"` (surface colour, unlit), `"normal"`
    (world-space normal, rgb = n × 0.5 + 0.5), `"depth"` (white near, black far: `depthRange` [near, far] metres, else from the nearest thing in view to 2.5 times the focus distance; sharp, never
    blurred by depth of field), `"objects"` and `"materials"` (an ID colour each; the same name is always the same colour), `"mask"`
    (white where `mask.objects` / `mask.materials` are, black elsewhere, each edge pixel its share of coverage). In Final the IDs and
    the mask come from the traced samples (a cryptomatte of two ranks a pixel), so they follow depth of field; Draft draws them with the
    raster, 4x multisampled.
- `rig.look.passMix` `{ "diffuse": 1, "specular": 1, "emission": 1 }` rebalances Final's light by kind after the trace, as a compositor
  would from the passes: `{ "specular": 1.5 }` makes every reflection and refraction half as bright again, `{ "diffuse": 0.8 }` darkens
  the matte light. It is exact (the passes add up to the picture), changing it later is one denoise, not a new trace; Draft is
  unchanged. Unset or all 1 traces exactly as before.
- **World matte**: any layer's `trackMatte` can take its matte from the Scene's objects instead of another layer: `"trackMatte":
  { "sourceId": "<the Scene layer's item id>", "mode": "alpha", "objects": ["bottle"] }` (or `"materials": ["glass"]`, or both). The
  layer then shows only where those objects are in the Scene's picture (an object covers everything under it), `"alphaInverted"`
  everywhere but there, with soft edges where they cover part of a pixel, in Draft and Final (Final's from its samples). Unlike an
  ordinary matte the Scene stays in the picture. Put the matted layer above the Scene layer: on a `cameraLocked` channel it lies flat
  over the picture (a title, a picture on a screen); on an ordinary channel it stands in the 3D space and the Scene's depth still hides it
  where the set is in front of its plane. Camera-locked layers and the Scene: the Scene's channel always stays at the top, under the camera
  (the editor and every load put it there), so its place in `channels` says nothing; the Scene is drawn right above the frame's footage.
  The background plate under the Scene is the `cameraLocked` footage and pictures (`video`, `image`) at the very bottom of the stack (only
  `cameraLocked` channels under them, the Scene's own not counting), with whatever is stacked under them; every `cameraLocked` layer stacked
  above the topmost of them (text, shape, HTML, a template, particles, a sequence, a picture with an ordinary channel under it) is drawn
  over the Scene, in stacking order, matte or not. Up to three different object sets per project; each costs one flat draw a frame in
  Draft and nothing to the trace but a few bytes a pixel. Use it for a title that passes behind a product (`alphaInverted` on the
  product), a picture or video shown only on one object, or a grade on one object (a copy of the footage graded and matted to it).

```json
"render": { "mode": "final", "spp": 128, "passes": { "show": "mask", "mask": { "objects": ["bottle", "cap"] } } },
"look": { "passMix": { "specular": 1.4 } }
```

**The Rig's backdrop** (`rig.cyclorama`) stands in the same world: its floor is at y = −0.42 × the composition height / 1000 metres
(−0.454 m at 1080p), centred on x = z = 0, and its sizes are multiples of the composition height (`width` 3.4 is 3.67 m at 1080p). A
scene built around y = 0 (a table top, a product) is best with `"cyclorama": { "shape": "none" }` and its own floor or backdrop object.

**Rig lights** (`rig.lights[]`, one set for every 3D layer, [video-3d.md](video-3d.md#scene-rig--one-set-for-every-3d-layer)) are placed differently:
around the rig origin by `az` (degrees around the vertical, measured from +Z, the camera's side, toward +X: 0 is in front of the subject
toward the camera, 90 camera-right, -90 camera-left, 180 behind the subject), `elev` (degrees above the horizon, 90 overhead) and `dist`
(composition pixels; one world metre is 1000). A `spot` or `area` Rig light aims at `targetX`, `targetY`, `targetZ` in pixels, with +Y up.
A Rig light's `intensity` is what the subject receives, as a directional of that strength would give, whatever its distance. With
`"renderer": "world"`, write the scene's own lights in `rig.scene.lights` and set `rig.lights: []`.

## Shadows in Draft

The editor's Draft preview leaves shadows out unless the Rig's `"render": { "draftShadows": true }` (next to `renderer` and `scene`) asks for them, because they are about half of what a big frame costs, so a shadow missing from the preview is not a fault. Renders and stills always have them, in Draft and Final. A light with a pattern keeps its shadow in the preview, because its shadow map draws the pattern. Without shadows the preview still lets the sky light a room only through its openings, and lights an open set's backdrop from what stands in front of it, as renders do: a room lit through its window is as bright in the preview as in a render, shadows aside.

## Fog and haze

`rig.scene.fog` fills the air of the set with an even medium that scatters light: dust in a room, haze, a smoky club. Beams show where
light passes through it (a spot's cone, sun shafts through a window, a lamp's glow) and the shadows of what stands in the light run
through the beams; things far away fade toward the fog's own light. Final traces it (the light it scatters from every kind of light and
from the environment, the shadows in the beams, what it takes from the light of what is behind it, and the fog's own light scattered
again); Draft draws the same fog through its lights, so the beams and the haze are there in the preview and in a Draft render.

```json
"fog": { "density": 0.1, "color": "#ece6dc", "anisotropy": 0.5, "min": [-2, 0, -2], "max": [2, 2.6, 2] }
```

- `density` [0, none]: how thick, per metre. A metre of it takes 1 − e^(−density) of the light that crosses it: 0.02 to 0.05 a faint
  haze, 0.08 to 0.15 a dusty room where a sun shaft reads, 0.3 and up a smoky club (the far wall of a 4 m room is then a third as bright).
- `color` [`#ffffff`]: the share of the light it takes that it scatters back out, per channel. White is bright fog; darker absorbs more
  (smoke); a tint colours the beams and the haze.
- `anisotropy` [0]: which way it scatters. 0 evenly; 0.3 to 0.7 forward, as dust and haze do: a beam glows when the camera looks along it
  toward the light and is faint from the side. Below 0, back toward the light.
- `bounces` [2], Final only: how deep into a light path it still scatters. 1 lights it by the light that reaches it (shafts, cones, a
  lamp's glow); 2 to 4 adds its own light scattered again, which thick fog needs to look soft and bright. More costs time.
  `rig.render.volumeBounces` caps the scatters themselves, for the fog and the sims' smoke alike ([render](#turn-it-on-and-write-a-scene)).
- `min`, `max`: the corners of its box, metres. Left out, the box round everything in the scene. In a room give the room's inside, so
  the sky outside its window stays clear and the sun reaching the window is not dimmed on the way.
- Beams need a dark set and a strong, small light: a `spot` (its cone), a `sun` through an opening (a window, a gap in a roof, the trees),
  or the environment's own sun through a window. A soft `area` light and an even sky light the fog evenly: haze, no beams. Lights' shadows
  are what draw the shafts, so leave `castShadow` on.
- It costs little: a Final still of a room in fog at 1080p and 64 samples takes about as long as without it (0 to 0.5 s more; the first
  one of a scene a second or two more while its shaders compile); Draft adds 1 to 4 ms a frame. A scene without `fog` costs nothing.
- Draft scatters the light of every light once, with each light's shadows, and adds the environment's light where the set leaves the sky
  open. It leaves out light scattered twice and light that surfaces throw back into the fog: the darkest air around a beam, and a floor
  under a bright beam, are darker in Draft than in Final. Judge thick fog in Final.
- A solid see-through object (a glass ball, a bottle, any closed glass) keeps the fog out: inside it is its own medium, so clear
  glass stays clear and a tinted one tints by its own `attenuationColor` (Final; Draft draws the fog behind glass from where the eye's ray
  leaves it). A thin `pane` or a thin-walled glass is a surface, not a room of its own: the fog goes on through it.
- Glass in front of fog, smoke or fire shows them through it in Draft as in Final (bent and tinted by a solid glass as the rest is).
- Over a see-through background (no `opaque`) fog and smoke cover what they hide and no more: the picture's alpha is 1 − their
  transmittance along each ray, so a render with alpha lays them over other footage exactly.
- Smoke and fire from a sim are their own ([Smoke and fire](#smoke-and-fire)) and stand in the fog together with it.

## Smoke and fire

Smoke, fire and explosions are a sim's gas: `rig.scene.sims` with a recipe (`pulse_explosion`, `campfire`, `smoke_column`) or a
`sim/1` graph with a `gas` block. They render in Draft and Final, push particles, and repeat exactly on every scrub and render. Final
traces them: smoke lit and shaded by every light and casting its shadow, fire glowing and lighting the set, both seen in mirrors and
through glass. Final traces every gas of a scene, any number of sims, each at its own res. Their grids share one GPU budget in
Final, the largest single allocation the GPU allows (4 GB on a Mac with Apple silicon); a sparse (brick) gas takes only the part of its
grid its smoke fills, growing with it. A gas past the budget is laid over the traced picture as Draft draws it (not lit by the scene's lights, not in mirrors or
through glass, no shadow) and the still's `scene.warnings` names it (lower its `res`, or the res of the gases before it). Everything is
in sim.md (GreenLight Dash only).

```json
"sims": [{ "recipe": "campfire", "at": [0, 0, 0], "size": 0.3 }]
```

`volumes` now holds only a `.blend` import's baked smoke and fire (`baked`), played back from its file; live `volumes` entries
(`preset`, `sources`) are gone and are ignored.

## Particles: snow, dust, smoke, sparks, bokeh, stars

Particles in the world are a sim's sets (sim.md (GreenLight Dash only)), drawn as what they are, never added up into light (a dense cloud stays as
bright as the light that reaches it):
- **lit cards** (`look: "card"`): sprites facing the camera with a texture (built-in `smoke`, `spark`, `dust`, `snow`, `leaf`, `drop`, made by
  the texture graph; or the agent's own graph, or the user's picture or flipbook sheet), lit and shadowed by the scene's lights, letting light
  through from behind, blended back to front;
- **into a volume** (`look: "volume"`): a cloud of puffs splatted each frame into a box of density that renders as a sim's gas does (Final:
  lit by every light, shading itself, shadowing the set);
- **glowing points** (a round look with an `emissive` material): in Final they are lights, so sparks and embers light the floor round them;
  `rig.look.bloom` makes them bloom.

Recipes: `snow`, `dust_in_beam` (with a beam of light and the scene's `fog` for the air), `smoke`, `sparks_in_wind`, `embers`, `bokeh`
(with the camera's `fStop` and `focus`: Final's real out-of-focus discs), `stars`.

```json
"sims": [{ "recipe": "snow", "at": [0, 3, 0], "area": [5, 0.1, 4], "count": 7000 }, { "recipe": "embers", "at": [0, 0.05, 0] }]
```

## Cloth and soft bodies

Cloth, hair, sand and soft bodies are a sim's XPBD pieces (sim.md (GreenLight Dash only) §2b): `rig.scene.sims` with a `cloth`, `hair`, `grains` or
`softbody` maker, or a recipe (`cloth_drop_on_sphere`, `flag_in_explosion_wind`, `grains_on_cloth`, `hair_in_wind`). They run on the GPU,
collide with themselves and with each other, and a cloth made from an object (`"mesh": "<object id>"`) takes that object's place. An
object's own `sim` field is gone (it is ignored): write the cloth as a sim. To settle a cloth into a shape that never moves, use the
`drape` or `inflate` graph ops.

## Water, sand, snow and goo

Liquids, sand, snow and goo are a sim's MPM set (sim.md (GreenLight Dash only) §2d): `rig.scene.sims` with `fill`, `pour` and an `mpm` op, or a recipe
(`water_splash_with_debris`, `water_pour`, `sand_pour_pile`, `snowball_smash`, `goo_drop`). Every material shares one grid on the GPU, so
they push each other; the sim's colliders, scene objects (`mpm.objects`) and its rigid pieces stand in the way, and the liquid pushes the
pieces back (a crate floats). Water and goo draw as a real surface (refracting in Draft, traced as a dielectric in Final), sand as grains.
The old `matter` field is gone and is ignored.

## Rigid bodies

Objects that fall, hit and stack. Add `rigid` to any object. On a `model3d` layer, `model3dConfig.physics: "falls"` does the same, and `"solid"` makes it a fixed body that others hit ([video-3d.md](video-3d.md)). They are bodies of the scene's own rigid sim (the sims' rigid solver, sim.md (GreenLight Dash only) §2c, where pieces, fracture, glue and swarms live too). With a cloth among `sims` (a recipe or a graph with an `xpbd` op: cloth, a soft body, hair, grains), the bodies run in that cloth's sim: the cloth catches and deflects a block that falls on it, and the cloth's colliders (the ball it drapes over) stand in the bodies' way. One way only: a body is not slowed by the cloth. A sim the bodies still pass through (a second cloth, one placed by its own `transform` or starting later, particles that collide) is named in `scene.warnings`.

```json
{
  "physics": { "gravity": [0, -9.8, 0], "floor": 0 },
  "objects": [
    { "id": "ramp", "material": "steel", "at": [-2.5, 0.9, 0], "rot": [0, 0, -22], "graph": [{ "op": "box", "size": [3.6, 0.14, 2] }], "rigid": { "fixed": true, "shape": "box" } },
    { "id": "crate", "material": "wood", "at": [1, 0.25, 0], "graph": [{ "op": "box", "size": [0.5, 0.5, 0.5] }], "rigid": { "shape": "box", "density": 0.25 } },
    { "id": "ball", "material": "steel", "at": [-4, 2.5, 0], "graph": [{ "op": "sphere", "radius": 0.26 }], "rigid": { "density": 8, "start": 0.3, "bounce": 0.1 } }
  ]
}
```

- `rigid: true` falls with the defaults. Options: `fixed` (never moves, others hit it), `keyed` (follows the object's keys and pushes what is in the way), `shape`, `mass` or `density`, `bounce` [0.25], `friction` [0.6], `velocity`, `spin`, `start` (seconds to hold it in the air).
- `shape`: `sphere` (the default for a sphere), `hull` (the default otherwise: the object's outline wrapped tight, so a C shape collides as a solid lump), `box`, or `mesh` (exact, and only for `fixed` things). Use `box` and `sphere` when the object is one: they are cheaper and steadier.
- `physics.fps`: the steps a second the physics takes (4 substeps each, up to 240), the scene's frame rate unless set. A fast collision (a ball hitting the floor at 10 m/s) wants more.
- `physics.floor` is the ground's height, or `null` for none. With no `physics` block, the editor puts the floor at the set's floor and uses a gravity of `[0, -5, 0]`.
- The fall is a sim: checkpoints make seeking back exact, and a render gets the same fall every time.
- A layer with `physics` on starts from wherever the layer stands. Moving the layer starts the fall again, and keyframes on its position are not followed.

## Motion blur

With `"motionBlurEnabled": true` ([video-projects.md](video-projects.md#motion-blur-render-only)) a render blurs a frame when something in the Scene moves across its shutter, not only a layer's transform:

- a scene object's, a flat layer's (`layers2d`) or `scene.camera`'s keys (`at`, `rot`, `scale`; the camera's `at`, `target`, `fov`, `lens`, `focus`, `fStop`), their drives on the scene's clocks (a clock's glide moving on past its last key included), the ƒx on their keys (a spring ringing past its key), a follow path, a card on a moving parent, and a rigged object's `pose` (its clips, keys and targets);
- what runs by itself: bodies (`rigid`, and model layers with `physics: "falls"`) until they rest, `sims` while their clip runs (gas, cloth and the rest of XPBD included, liquids too), baked smoke and fire, and a `.blend` import's baked playback while its frames run (a baked track that holds still counts as still);
- the Rig's own keyframes (`sc:` and `scc:` tracks: lights, the backdrop, the environment);
- 3D Text letters a Text Animator moves: a keyed track while it changes, a Time cascade while a letter is in flight, Flow, Wiggle, Scramble and a blinking caret (the same rule holds for 2D text, flat letters in the world included);
- a model layer's own GLB clips while they play and the pose changes.

A frame where all of it rests renders once, as sharp as with blur off.

In **Final** a frame whose motion is all inside the world is traced **once**: each camera sample takes its own time inside the shutter
(spread evenly over it, pixel by pixel), and everything stands where it is at that time, so a moving object or a camera move blurs as a
continuous smear, in about the time of a sharp frame. What the world traces that way, and what still renders the frame as an
accumulation of sub-frames (each one a full trace):

- traced once: scene objects (`at`, `rot`, `scale` keys, parents included), lit flat layers (`layers2d` with `receiveShadow`) and
  `scene.camera`'s `at` / `target` keys, or the Camera layer's move when it films the Scene; a zoom (`fov`, `lens`, the Camera layer's
  zoom), a focus pull (`focus`) and a change of aperture (`fStop`, the Camera layer's aperture) on a perspective lens; what changes shape:
  a rigged object's `pose` and a skinned model, shape keys, a sim's cloth and soft bodies (each vertex at the shutter's opening, middle and
  close); `sims`: their particles (spheres, points, sparks, cards, birds, models, and cubes, chunks and leaves) each along its own
  velocity (the spheres, points, sparks, cards and birds on the parabola of how their velocity turned over the sim's last frame: a swirl
  smears on its curve; cubes, chunks and leaves straight), birds beating their wings through the shutter (each at its own beats a second), a gas's smoke and fire carried along its own
  flow, in a dense box or on bricks (the gas an emitter puts in within the shutter stays at the emitter, and the burn's heat and smoke are
  added for each sample's time; liquids stand as at the frame); bodies (`rigid`, model layers with `physics: "falls"`) as the solver takes
  them through the shutter, step by step (one that hits the floor inside the shutter bounces in the blur); lights that move (one that follows a moving object, one inside a model) and the
  Rig's own keys on its lights (`sc:<lid>:intensity` and the light's other numbers, `scc:<lid>:col`: each sample sees the light's
  colour, strength, place, size and cone at its own time); moving glowing surfaces (`emission`, a `screen`: their light comes from where
  they are at each sample's time); translucent sheets, and subsurface bodies (the light's walk inside goes through the body where it
  stands, and as it is bent, at each sample's time: a wax or skin figure that swings its arm too); a shadow catcher over footage (a Scene
  put into footage: the shadow and the objects' coverage are the shutter's); the model layers the world draws (their keys, their GLB clips,
  their `pose`, their morphs); a `.blend` import's baked tracks (an object's matrix at each frame), baked shapes (each point between its
  frames), remade meshes (each point toward the surface of the frames around), baked grains and flocks (each copy along the bend through
  where it stands at the shutter's opening, middle and close: a ring of grains spinning past a baked frame smears on its arc) and `volumes` (baked smoke and fire, marched at eight times across the shutter and averaged); the Rig's keys on its environment
  (`sc:env:intensity`, `sc:env:rotY`), an Ambient's or a Hemisphere's colour and strength, and its backdrop's colour (`scc:cyc:col`): each
  sample sees the map and the paint as they are at its time; the backdrop's place, turn, scale (`sc:cyc:x`, `rotY`, `scale`, ...) and
  opacity, and the environment's exposure (`sc:env:exposure`); a shadow-catcher backdrop's keyed tint and strength (the frame's catcher is
  their mean over the shutter); an aperture that opens from a pinhole (`fStop` 0: the frame is traced through
  the widest aperture of its shutter, each sample's point on the lens scaled to its own time's); 3D Text letters the world takes (a top-level
  3D Text layer, not camera-locked, no effect of its own): moved by their Text Animators, the layer's keys, its parent or its track, each
  letter stands where it is at each sample's time (a letter at scale 0 stands shrunk to nothing there), and a letter that fades, changes
  colour or is typed in inside the shutter (an Opacity or Fill animator, a typewriter) shows each sample its colour and opacity at that
  time (a letter typed in fades in over the step it comes in; a letter in a Scene material keeps the material and shows whole until it
  goes); texture graphs keyed by their own `keys` or alive in time (the animated presets), and the Rig's keys on a texture graph's numbers
  (`sc:g~<material>:<param>`): their maps are baked as the mean of 32 times across the shutter (a band sweeping a wall smears as it goes);
  an orthographic camera that zooms (`orthoHeight` keyed), a lens shift keyed inside the shutter (`shift`; an orthographic frame that
  slides) and a tilted lens that leans (`tilt` keyed), zooms, refocuses or opens: each sample through its time's frame and plane of focus
  (over a see-through sky the frame's coverage holds every one of those frames); unlit `layers2d` cards and unlit flat letters while the camera moves or zooms, and
  cards keyed to move: drawn over the traced frame at 48 times of the shutter and averaged in linear light (what stands in front of a card
  is the frame's middle); a shutter that crosses a cut into another Scene layer (another
  environment map or backdrop shape): the frame keeps its own Scene, and that Scene's own clock (held at its end), for the whole shutter,
  as each frame of an edit shows its own shot;
- accumulated: caustics; a Rig key that brings a texture
  graph's map in or out (a noise's glow from 0); glass 3D Text letters that fade or change colour, a letter whose caps and sides change
  colour apart, or a 3D Text layer that starts, ends or crosses into another clip inside the shutter; a `layers2d` card that comes or goes
  inside it, and splats while the camera moves; a model layer the world does not draw (one of the six effects live, a blur, a flat effect), a model
  layer moved by a parent or a motion track; and any other layer of the project that moves on that frame. The footage is held at the
  frame's own picture.

Where the Scene lets the layers below show through (no `opaque` environment, no colour `background`), a moving edge over that sky is
see-through in proportion to how much of the shutter something covers it, and it goes over the layers below in linear light: the frame is
what the many sub-frames, each laid over them and averaged as light, give (an arm sweeping over dark footage keeps its brightness; laid
in display values it came out about a third darker). The same over a gradient, a pattern or a picture `background` that fills the frame. A
frame without motion, and a moving frame's pixels the world covers whole, go over them exactly as before.

A shadow catcher's shadow (a `catcher` object, a Rig backdrop in "Shadows only", a Scene put into footage) is the share of the light the
objects take from the floor, and it is taken from the footage, or the project's background, in linear light: a shadow that takes half the
light leaves half of it (laid in display values it left about a fifth, so shadows came out far darker than real shadows in the same shot).
On a frame traced moving, an object's smear over a catcher keeps the object's own colour for the share of the shutter it covers each
pixel, and the floor's share keeps its shadow (the smear used to come out black over the floor and dark over the sky).

In **Draft** a frame whose motion is all inside the world draws the world at each sub-frame's time and averages their light before the
film look, as Final's trace does, so Draft's blur and Final's agree in direction, length and look (a fast object's tails fade alike);
the Rig's keyed lights, the model layers the world draws, 3D Text letters, the bodies and the birds' wingbeats stand where they are at each sub-frame's
time; it draws as many sub-frames as the fastest move on the screen needs (the Blur level's count, more when two would stand more than 2
pixels apart, at most 64), so a fast spin smears instead of showing banded copies, and such a frame costs that many draws; past 64 (more
than 128 pixels of travel) each sub-frame is smeared along each pixel's own motion over its share of the shutter, so the copies blend into
each other (their edges step about half as much), for one plain extra draw of the world a sub-frame;
3D Text letters that fade or change colour are drawn in their colour at each sub-frame's time; unlit cards and flat letters over the held
frame are drawn at 48 times of the shutter and averaged in linear light; over a see-through sky the moving edges' coverage is the shutter's and goes over the layers below in linear light, as in Final. A Draft Scene with gas, `volumes`, splats, effects on
objects or a shadow catcher, or a frame where another layer moves too, averages its sub-frames as pictures, as a 2D
project does. A sim's particles in Draft are drawn at the
time drawn (moved on by their velocity from the sim's own frame), so the sub-frames between two sim frames see them move. A static frame
traces exactly as with blur off.
