> **GreenLight Motion Engine:** this is the GreenLight Dash Video Editor's project format, which the engine reads as is.
> Ignore the `/api/...` routes and the app UI described here: in the engine you edit `project.json` (or `apply`) and run
> `npx greenlight-motion build`; what `GET /api/video-editor/capabilities` returns there is `npx greenlight-motion schema <topic>`
> here. `frontend/src/…` paths are files of the engine's public source repository. MotionFast templates (`mediaType: "motion"`)
> stay in GreenLight Dash.

# GLEA — Models, devices and characters in the 3D Scene

> Read [video-projects.md](video-projects.md) for the shared project, clip, channel, timing and versioned-write contracts. Load only the sections
> the task needs.

Read this page when something ready-made goes into a 3D Scene: a phone, tablet, laptop or iMac from the
[preset table](#bundled-device-presets), a model file (`.glb`, `.gltf`, `.obj`, a Gaussian splat) or a character. **3D in a video is
the 3D Scene** ([video-world3d.md](video-world3d.md); start with world3d-quickstart.md (GreenLight Dash only)): a Scene layer (a `rig` clip,
`rig.renderer: "world"`) whose world you build and model yourself (objects from ops, materials, lights, the environment), filmed by the
timeline's Camera layer ([video-camera.md](video-camera.md)). A device the film shows is taken ready-made from the preset table unless the task asks
you to model it yourself or names another model. Model layers in a project with no Scene layer, a Camera layer flying over flat layers, a
pre-rendered mockup clip and an HTML clip standing in for a Scene are not a video's 3D. Which tool an object takes is
decided first, by the table in [Which 3D](video-world3d.md#which-3d-choose-first): an object that is not a real thing or
physics may be a WebGL page (an HTML clip).

## Contents

- [Model layer or Scene object](#model-layer-or-scene-object)
- [A model layer in the Scene](#a-model-layer-in-the-scene): [the clip](#the-clip-and-its-url), [on the timeline](#on-the-timeline), [place and size](#place-and-size), [what the Scene does with it](#what-the-scene-does-with-it), [Draft and Final](#draft-and-final), [check it](#check-it)
- [Devices from the preset table](#devices-from-the-preset-table)
- [Media on a model's screens (`screen`, `screens`)](#media-on-a-models-screens-screen-screens)
- [`model3dConfig` fields](#model3dconfig-fields)
- [Shapes from the Scene panel (`model-primitive:`)](#shapes-from-the-scene-panel-model-primitive)
- [Characters](#characters)

## Model layer or Scene object

A model file goes into a Scene in one of two ways. A `model3d` layer is a timeline layer the world draws; a Scene object with
`"model": "/media/….glb"` is one of `rig.scene.objects` ([video-world3d.md](video-world3d.md#the-scene-format)).

| What goes in | As | Why |
| --- | --- | --- |
| A phone, tablet, laptop or iMac from the preset table | a `model3d` preset layer | ready-made; its `screen` picture reads upright on every preset |
| A character whose file has its own animations or face morphs; one that speaks with morphs; a `.blend` character (`to-glea`) | a `model3d` layer with `model3dConfig.pose` ([video-characters.md](video-characters.md)) | a Scene object's pose plays only `skeleton.clips` and has no morphs |
| A machine or teardown baked as an animated GLB | a `model3d` layer (`animation.clip`, mechanisms.md (GreenLight Dash only)) | the layer plays the file's glTF clips |
| A still prop or a scan that needs a Scene material, Scene keys, clocks, paths or parents, light linking (`tags`), `visibility` or `holdout`, or that other objects ride | a Scene object `{ "model": … }` | a model layer reaches the world only as its file, its place, its physics and its skeleton |
| A mesh with no skeleton that you rig yourself | `skeleton` on either ([video-characters.md](video-characters.md#skeletons-for-meshes-that-have-none-skeleton)) | the same rig; a Scene object runs on the Scene's clock, a layer on its own |

`POST /api/world3d/prepare-asset` measures a file and answers both forms (`sceneSnippet`, a Scene's `rig` with the model as a Scene
object and no camera, and `layerSnippet`, a model clip and item standing where that object stands) and `cameraPose`, a shot that frames
it for the Camera layer; with `apply: true` it adds the Scene object (and, in a project without a Camera layer, a Camera layer from `cameraPose`) ([video-world3d.md](video-world3d.md#check-your-work)).

## A model layer in the Scene

<a id="3d-model-layers-mediatype-model3d--a-live-glbgltfobj-rendered-per-frame"></a>

### The clip and its url

A `model3d` clip is loaded like a video clip: **a clip with no `url` is dropped on load and render, and every item that uses it goes with
it**, even one with a complete `model3dConfig`. The project still saves and a render still "succeeds", with the model missing. The url:

- **Preset device:** `"url": "model-preset:<presetId>"`, a sentinel (the bundled file's real URL changes every release). Set
  `"source": "preset"` and the same `"preset"` in `model3dConfig`: the renderer takes `model3dConfig` first and falls back to the url,
  but the url keeps the clip alive.
- **Model file:** an uploaded asset url ending in `.glb`, `.gltf` or `.obj` (upload through the media API, use the returned
  `/media/...` url), with `"source": "custom", "preset": null`.
- **Gaussian splat:** a `.ply`, `.splat` or `.spz` url ([video-world3d.md](video-world3d.md#gaussian-splats)).
- **Shape:** `"url": "model-primitive:<kind>"` ([below](#shapes-from-the-scene-panel-model-primitive)).

Model layers render in the full render paths (`/render-onserver`, its job, `/render-still`, the desktop Download), never in the fast
`/render` (rendering.md (GreenLight Dash only)). Past about 900 k triangles a model renders slowly enough that an
export looks hung: decimate it first (`prepare-asset` says when, `decimateRecommendation`).

### On the timeline

A model layer stands in the Scene only on frames where the Scene layer is on the timeline. Give it a channel of its own (`unsnapped: true`,
top level, not locked to the camera, not inside a sequence) and the Scene item's span: `freeStart` = the Scene item's start, `trimStart` 0,
the same length. That is what the Scene panel does when it adds one, and adding a model in the editor adds a Scene layer when there is
none. Past the Scene clip a render draws no world, and a model item that runs on is drawn by a pass of its own, untraced and lit by the
nearest Rig. The layer's keys, `animation` and pose keys count the layer's seconds and the Scene's keys the Scene's: with the two items
starting together they are the same seconds.

### Place and size

One world metre is 1000 composition px. The layer stands where `panX`, `panY` (% of the frame) and `panZ` (px) put it: at
x = `panX` / 100 × W / 1000, y = −`panY` / 100 × H / 1000, z = `panZ` / 1000 metres (W, H the frame's size; `panY` is down-positive);
keys on `xPercent`, `yPercent`, `translateZ` move it in the same units ([placing 3D Text](video-world3d.md#placing-3d-text-in-the-world) uses
the same formulas).

- **Size by a real measure.** `fit` + `fitValue` size the model's box as the file rests (a skinned character through its bones):
  `fit: "height"` → `fitValue` = height in m × 1000 / H × 100; `fit: "width"` → width in m × 1000 / W × 100; `fit: "unit"` → px per model
  unit (a file in metres at its real size: 1000). A device that stands portrait in its file (a phone, `ipad`) is sized by its long side
  with `"height"`, then turned; a laptop by its width with `"width"`.
- **Stand it on a floor.** `anchor: "base"` puts the box's lowest point at the layer's place: on a floor at height y,
  `panY` = −y × 1000 / H × 100. `anchor: "center"` (the default) puts the box's centre there; `"origin"` the file's own origin (a GLB
  exported in scene coordinates lands where its scene put it). `placeOnRigFloor` (default `true`) stands it on the Rig backdrop's floor
  instead (`rig.cyclorama` with a floor, [video-world3d.md](video-world3d.md#the-rig-backdrop-rig-lights-and-environment)), the Y transform then an
  offset from it: set it `false` on a floor of your own.
- **Turn it** as a Scene object turns: `rotateX` is `rot[0]`, `rotateY` is `rot[1]`, `rotateZ` / `rotation` is `rot[2]` negated (clockwise
  as you face it); keys too. `model3dConfig.baseRotation` (`{ x, y, z }`, degrees) is a fixed turn under them, read the same way
  ([video-world3d.md](video-world3d.md#model-layers-in-the-world)).
- **Physics:** `model3dConfig.physics: "falls"` makes it a rigid body that falls, hits and stacks from where the layer stands; `"solid"` a
  fixed one others hit ([video-world3d.md](video-world3d.md#rigid-bodies)). Keys on its position are then not followed.

### What the Scene does with it

- It is lit by the Scene's lights and environment (and the Rig's lights, unless `rig.lights` is `[]`), casts and takes the Scene's shadows,
  shows in reflections, is path traced in Final and blurred by the Scene's motion blur and depth of field.
- Not read in a Scene: `model3dConfig.env`, `lights`, `shadow`, `castShadow` and `receiveShadow`, a `screens` entry's `shading` and
  `receiveShadow` (the world draws every screen glowing in its picture's colours, so the set's shadows do not darken it), and the
  layer's `opacity` and `blendMode` (bring it in and out with scale, position or rotation keys). A screen that must take the set's light
  and shadows in a Scene is a Scene object whose material has `"screen": { "layer": "<item id>", "shading": "lit" }`
  ([video-world3d.md](video-world3d.md#the-scene-format)).
- It keeps its file's materials: no Scene material, Scene keys, clocks, paths or parents, light linking, `visibility` or `holdout` (a Scene
  object takes those). It cannot ride a Scene object (`worldParent` is for text and pictures); a character's `attach` can hold it, and a
  pose can aim at it (`{ "model": "<item id>" }`, [video-characters.md](video-characters.md#constraints)).
- It leaves the world for a pass of its own (no Scene shadow, not traced in Final, still lit and filmed as the world shows it) while its
  channel is locked to the camera, and while an effect that needs a pass of its own, a blur or a flat effect is live: which effect does
  what is in [effects-depth.md](video-effects.md#in-a-3d-scene). A model inside a sequence is not part of the world.
- It takes no transitions ([video-transitions.md](video-transitions.md)).

### Draft and Final

Draft draws the model with the Scene's light; the editor's preview leaves shadows out unless `rig.render.draftShadows` is `true`, while
renders and stills always have them ([video-world3d.md](video-world3d.md#shadows-in-draft)). Final path traces it, and its screens light the set. A
splat is never traced and casts no shadow. A Scene draws only on the WebGPU engine: on the editor's WebGL engine the preview shows a notice
where the Scene and its models would be; renders and stills of the project run on WebGPU whatever the engine.

### Check it

Render stills (rendering.md (GreenLight Dash only)) at the model's first and last frames and
where it moves most, in Final for the look. `POST /api/world3d/validate` and `GET /api/world3d/help` cover a model layer's `pose` and
`skeleton` only: nothing checks its url, preset or fit, so the still is the check.

## Devices from the preset table

<a id="bundled-device-presets"></a>A phone, tablet, laptop or iMac the film shows is one of these, as a `model3d` layer standing in the
Scene with its picture in `screen` (below), unless the task asks you to model it yourself or names another model.

| `preset` id | Device | Screen artwork | `baseRotation.y` to face the camera |
| --- | --- | --- | --- |
| `iphone_pro_max` | iPhone 17 Pro Max | yes | `180` |
| `iphone_air` | iPhone Air | yes | `0` |
| `double_iphone` | Two iPhones | yes | `180` |
| `ipad` | iPad | yes | `0` |
| `ipad_mini` | iPad mini | yes | `180` |
| `macbook_pro` | MacBook Pro | yes | `0` |
| `macbook_air` | MacBook Air | yes | `0` |
| `imac` | iMac | yes | `180` |

`iphone_17` is an alias of `iphone_pro_max` (same model, `baseRotation.y: 180`): write `iphone_pro_max`. Most of these files are authored
facing away from the viewer, so the last column's `baseRotation.y` turns the display to the camera (the editor sets it when it adds the
layer); a wrong value shows the device's back.

Size a device by its real measure (above): a 31.3 cm wide MacBook Pro on a 1920-wide frame is `fit: "width"`, `fitValue` 16.28; a 24.8 cm
tall iPad on a 1080-high frame is `fit: "height"`, `fitValue` 22.94. `"fit": "unit"` with 1000 does not give a device its real size
(its file is not in metres).

A Scene layer and a phone standing in it, as they go into the project's `clips` and `channels` (the Scene's channel first, its `rig` clip's
empty `url` is right). On a 1080 × 1920 frame the 16.3 cm phone (`fitValue` 0.163 × 1000 / 1920 × 100 = 8.49) stands on a floor whose
top is at y = −0.5 (`panY` 26.04), turned as an object at `rot: [0, -22, 0]`:

```json
"clips": [
  { "id": "c-rig", "source": "LOCAL", "mediaType": "rig", "url": "", "name": "Scene", "duration": 6 },
  { "id": "c-phone", "source": "REMOTE", "mediaType": "model3d", "url": "model-preset:iphone_pro_max", "proxyUrl": null, "name": "iPhone 17 Pro Max", "duration": 6 }
],
"channels": [
  { "id": "ch-rig", "name": "Scene", "kind": "rig", "visible": true, "unsnapped": true,
    "items": [{ "id": "i-rig", "clipId": "c-rig", "trimStart": 0, "trimEnd": 6, "freeStart": 0, "rig": { "renderer": "world", "lights": [], "scene": { } } }] },
  { "id": "ch-phone", "name": "Phone", "visible": true, "unsnapped": true,
    "items": [{ "id": "i-phone", "clipId": "c-phone", "trimStart": 0, "trimEnd": 6, "freeStart": 0, "panX": 0, "panY": 26.04, "panZ": 0, "rotateY": -22,
      "model3dConfig": { "source": "preset", "preset": "iphone_pro_max", "fit": "height", "fitValue": 8.49, "anchor": "base", "placeOnRigFloor": false,
        "baseRotation": { "x": 0, "y": 180, "z": 0 }, "screen": { "url": "/media/admin/{board_id}/app-screen.png", "fitMode": "cover" } } }] }
]
```

The timeline's Camera layer then frames it ([filming the Scene](video-world3d.md#filming-the-scene-with-the-camera-layer)): a phone at its real
size wants the camera about half a metre away. A reel of many phones on one spinning object is modelled in the Scene instead
([video-world3d-notes.md](video-world3d-notes.md)).

## Media on a model's screens (`screen`, `screens`)

**A device's display — `screen`.** `model3dConfig.screen` puts an image or video on the device's display, using the same pipeline as the Mockup builder: `{ "url": "<media url>", "scale": 1 (0.1–5), "offsetX": 0, "offsetY": 0 (±1), "rotation": 0 (±180°), "padding": 0 (0–0.45), "fitMode": "cover"|"contain", "borderRadius": 0 (0–0.5) }`. Only stored when `url` or `layer` is set; dropped when the layer switches to `source: "custom"`. On a preset, use `screen`, never `screens` naming its display: the display sits under an opaque cover glass that only `screen` fades (to 0.15 opacity).

**Media on any model's own meshes — `model3dConfig.screens`.** Up to 8 entries, each putting an image or a video on the meshes whose node name (`node`) or first material name (`material`) matches — a slab showing a live UI, a TV, a poster, a phone inside a scene, on custom GLBs and presets alike:

```jsonc
"screens": [{
  "material": "UI_panel",            // or "node": "Screen_mesh"
  "url": "/media/admin/{board_id}/screen.mp4",
  "fitMode": "stretch",              // stretch (fill the mesh's own UVs — default) | cover | contain
  "aspect": 1.7778,                  // canvas aspect for cover/contain (default 16:9)
  "uv": "mesh",                      // mesh = the glTF UVs | planar = projected over the mesh's two largest axes
  "shading": "screen",               // screen = self-lit, exact colours | lit = takes the set's light, shadows, reflections and still glows (outside a 3D Scene; in one it glows)
  "receiveShadow": true,             // screen only, outside a 3D Scene: shadows still fall on it (colours stay exact elsewhere). Default off
  "offset": 0, "loop": true,         // video: seconds into the media at the layer's first frame; loop or hold the last frame
  "mirrorX": false, "flipY": false,  // UV fixes for oddly authored meshes (glTF UV origin is top-left)
  "scale": 1, "offsetX": 0, "offsetY": 0, "rotation": 0, "padding": 0, "borderRadius": 0
}]
```

**A layer of the same project on a screen — `layer`.** Instead of `url`, a `screen` or a `screens` entry can take `"layer": "<item id>"` (or a channel id: its item at the playhead): the screen shows that layer's picture at the playhead, drawn live every frame. An HTML clip (including a HyperFrames page) runs its own page and needs no bake: an edit of the `.html` shows on the screen as soon as the editor sees the file change, and renders draw the same frames. A video layer plays in step with the timeline, an image layer shows its picture. Text, shape and sequence layers are not shown (make them an HTML clip). Hide the source layer's channel (`"visible": false`) to show it only on the screen. The screen's canvas is the source's own size (an HTML clip's `html.width` × `html.height`, a video's frame), so it is only as sharp as that; `"resolution": [w, h]` lays an HTML page out at another size. Nothing is uploaded again while the layer shows the same frame (paused, a still page), so Final keeps its samples.

```jsonc
"screens": [{ "node": "Screen", "layer": "i-ui", "aspect": 2.3846, "fitMode": "cover", "look": "monitor" }]
```

**A real monitor's look — `look: "monitor"`** (on `screen` or a `screens` entry; a 3D Scene draws it): a glossy glass coat with soft reflections of the room over a near-black panel, and blacks lifted a few levels as an LCD's backlight shows through (`blackLevel`, 0–0.5, default 0.02 with the look, 0 without). `strength` [1] is how much light the screen throws on the room; how bright its picture looks is `brightness` [1, the page as it is], and in a 3D Scene the picture is shown in its own colours, out of the Scene's exposure, curve and bloom (`filmed: true`: through the film as a light); `glass` is the coat's roughness [0.1] (higher: a matte anti-glare screen). In Final a screen lights the room as a real light (sampled directly, so a keyboard under it is clean at the usual samples), and its weight as a light follows the picture it shows. In Draft the look adds a soft light from the panel in the colour its picture averages to, following it as it changes (no shadows; `"light": false` leaves it out). Without `look` a screen keeps the plain glowing panel.

Outside a 3D Scene (a model drawn in a pass of its own), a `screen`-shaded mesh shows the media in **its own colours**: its pixels skip the 3D tone curve (a depth-tested coverage mask, so anything in front still hides it), so a UI on a slab matches the same file as a 2D layer. Inside a 3D Scene a glowing screen's picture is shown the same way. Being self-lit it takes no light — and so no shadow: a character walking on a page or a UI looks as if it floats. Set `receiveShadow: true` on such a screen and the set's shadows darken it where they land (by the casting lights' share of the set's light), while every other pixel keeps the media's exact colours. Use it for any screen something stands on or passes over. Videos are driven by the layer clock and are **frame-exact in exports and stills** for MP4/MOV (the device `screen` uses the same path). WebM falls back to a seeked `<video>` (best effort).

## `model3dConfig` fields

Out-of-range values are clamped; an unknown enum value falls back to the default. Every field below works in a Scene.

| Field | Values / range | Default | Meaning |
| --- | --- | --- | --- |
| `source` | `"preset"` \| `"primitive"` \| `"custom"` | `custom` | Where the geometry comes from. Anything else reads as `custom`. |
| `preset` | preset id | `null` | Required with `source: "preset"`. An unknown id falls through to the clip url. |
| `primitive` | `{ kind, color, text }` | — | With `source: "primitive"` ([below](#shapes-from-the-scene-panel-model-primitive)). |
| `fit` | `"height"` \| `"width"` \| `"unit"` | `height` | How `fitValue` sizes the model: % of the frame's height, % of its width, or px per model unit ([place and size](#place-and-size)). |
| `fitValue` | `0.01–10000` | `60` | With `fit: "height"`, `60` = the model's box spans 60 % of the frame's height. |
| `anchor` | `"center"` \| `"base"` \| `"origin"` | `center` | The point that stands at the layer's place: the box's centre, the box's lowest point, or the file's own origin. |
| `placeOnRigFloor` | bool | `true` | Stand it on the Rig backdrop's floor; the Y transform is then an offset from that floor. `false` on a floor of your own. |
| `physics` | `"off"` \| `"falls"` \| `"solid"` | `off` | A rigid body of the Scene ([video-world3d.md](video-world3d.md#rigid-bodies)). |
| `baseRotation` | `{ x, y, z }` degrees, `±360` | `{0,0,0}` | A fixed turn under the keyed one. |
| `animation.clip` | glTF animation name \| `"*"` \| `null` | `null` | Plays the named animation of the file; `"*"` plays every clip together, each on its own length (Blender writes one clip per animated object); `null` = still. Names exactly as in the file. With a `pose`, it only names the base clip when `pose.clips` is empty. |
| `animation.speed` | `-8–8` | `1` | Playback rate (negative = reversed). |
| `animation.loop` | `"once"` \| `"loop"` \| `"pingpong"` | `loop` | `once` holds the last frame. |
| `animation.offset` | `±600` s | `0` | Seconds into the animation at the layer's first frame. |
| `skinning` | `"dualQuaternion"` \| `"linear"` | the file's (`linear`) | How the file's own skeleton bends its skin: `dualQuaternion` keeps a bent elbow's thickness and a twisted wrist round. Stored only when set. Not on a `skeleton` you make (it has its own `skinning`). |
| `skeleton` | object | absent | Bones and weights for a file that has none ([video-characters.md](video-characters.md#skeletons-for-meshes-that-have-none-skeleton)). Not on a shape. |
| `pose` | object | absent | A character's pose: clips crossfaded, morphs, bones, constraints, layers, speech ([video-characters.md](video-characters.md)). |
| `screen` | object | absent | The picture on a preset device's display ([above](#media-on-a-models-screens-screen-screens)). |
| `screens` | list, up to 8 | absent | Pictures, videos or layers on any model's meshes ([above](#media-on-a-models-screens-screen-screens)). |

`env` (`hdr`, `intensity`, `exposure`, `rotation`), `lights` (`key`, `fill`, `rim`), `shadow` (`enabled`, `opacity`, `blur`),
`castShadow` and `receiveShadow` are read only by a model drawn in a pass of its own outside a Scene; the editor fills them in with
defaults. Leave them out.

## Shapes from the Scene panel (`model-primitive:`)

The Scene panel's Shapes tiles (and Add Layer ▸ 3D Model) add procedural stand-ins as model layers: `"url": "model-primitive:<kind>"` on
the clip, `"source": "primitive"` and `"primitive": { "kind", "color", "text" }` in `model3dConfig`, keeping the url's kind the same.
They take no Scene material, keys or clocks: build your own shapes as Scene objects from ops ([video-world3d.md](video-world3d.md#ops)); read these when
a user's project has them.

| Field | Values | Default | Notes |
| --- | --- | --- | --- |
| `primitive.kind` | `cube`, `sphere`, `card`, `torus`, `cone`, `cylinder`, `human`, `car`, `text` | `cube` | An unknown kind loads as `cube`. Keep the clip url's `<kind>` the same. |
| `primitive.color` | any CSS colour, ≤ 64 chars | `#d9d9d9` | Tints the whole shape (the car's glass and tyres keep their own colour). |
| `primitive.text` | string, ≤ 40 chars | `TEXT` | Only read by `kind: "text"` (extruded letters). |

The editor's `fitValue` for each at comp scale: cube and sphere 24, card 26, torus 22, cone and cylinder 28, human 58, car 20, text 14.

## Characters

<a id="characters--the-pose-pipeline-model3dconfigpose"></a><a id="skeletons-for-meshes-that-have-none-skeleton"></a>A character on a
model layer moves by `model3dConfig.pose` (the file's clips crossfaded, morphs, bones, look-at, IK, holding things, layers with masks,
speech) and a file with no skeleton gets one from `model3dConfig.skeleton`: both are in [video-characters.md](video-characters.md), with the speech
fields and the lip-sync route in [video-world3d.md](video-world3d.md#a-character-speaks-posespeech).
