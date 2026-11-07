> **GreenLight Motion Engine:** this is the GreenLight Dash Video Editor's project format, which the engine reads as is.
> Ignore the `/api/...` routes and the app UI described here: in the engine you edit `project.json` (or `apply`) and run
> `npx greenlight-motion build`; what `GET /api/video-editor/capabilities` returns there is `npx greenlight-motion schema <topic>`
> here. `frontend/src/…` paths are files of the engine's public source repository. MotionFast templates (`mediaType: "motion"`)
> stay in GreenLight Dash.

# GreenLight Dash — 3D models, scene lighting and shadow plates

> Read [video-projects.md](video-projects.md) for the shared project, clip, channel, timing and versioned-write contracts. Load only the sections needed for the task.

## Contents

- [3D model layers (`mediaType: "model3d"`) — a live GLB/GLTF/OBJ rendered per frame](#3d-model-layers-mediatype-model3d--a-live-glbgltfobj-rendered-per-frame)
- [Scene Rig — one set for every 3D layer](#scene-rig--one-set-for-every-3d-layer)
- [Turning flat layers in 3D — pivot and stacking](#turning-flat-layers-in-3d--pivot-and-stacking)
- [Flat layers in the 3D scene — `item.shadowPlate`](#flat-layers-in-the-3d-scene--itemshadowplate)

### 3D model layers (`mediaType: "model3d"`) — a live GLB/GLTF/OBJ rendered per frame

Unlike a device mockup (pre-baked to a video file), a `model3d` layer is a **real 3D scene rendered live every frame** by the Player (three.js, its own depth-buffered pass), then composited like any other layer. The model can be one of the bundled device presets, a primitive stand-in or a custom uploaded asset. It takes the project camera, keyframes and layer parenting like any layer. Effects work on it only in part: see [Real 3D on 3D model layers](video-effects.md#real-3d-on-3d-model-layers); layer effects marked `disabledWhen3d` in capabilities (Motion Blur, Rig (Puppet), the warps, Layer Mask…) do not run on it. It takes no transitions ([video-transitions.md](video-transitions.md)).

**Never leave the clip `url` empty: the layer disappears without a warning.** A `model3d` clip is loaded like a video clip, so a clip with no `url` is dropped on load and render, and every timeline item that uses it goes with it — even one carrying a complete, valid `model3dConfig`. The project still saves and a headless render still "succeeds", with the model missing from every frame. The valid url forms:

- **Preset device:** `"url": "model-preset:<presetId>"` — a stable sentinel, NOT a fetchable path. (The bundled .glb's real URL is a content-hashed build artifact that changes every release; the sentinel survives app updates.)
- **Primitive shape:** `"url": "model-primitive:<kind>"` — a stand-in built in code, no asset file. Pair it with `"source": "primitive"` and `"primitive": { "kind", "color", "text" }` in `model3dConfig` (see below).
- **Custom model:** a real uploaded asset URL ending in `.glb`, `.gltf` or `.obj` (upload via the media API, then use the returned `/media/...` url).
- **Gaussian splat:** a `.ply`, `.splat` or `.spz` url. Only a 3D Scene draws splats (world3d.md (GreenLight Dash only)).

**Clip + item pair (preset device):**

```json
// clip — url is the preset sentinel, source REMOTE, no proxy/thumbnail
{ "id": "m1", "source": "REMOTE", "mediaType": "model3d",
  "url": "model-preset:iphone_pro_max", "proxyUrl": null, "name": "iPhone 17 Pro Max", "duration": 4 }
// item — model3dConfig holds everything about fit, look and animation
{ "id": "mi1", "clipId": "m1", "trimStart": 0, "trimEnd": 4,
  "model3dConfig": {
    "source": "preset", "preset": "iphone_pro_max",
    "fit": "height", "fitValue": 60, "anchor": "center", "placeOnRigFloor": true,
    "baseRotation": { "x": 0, "y": 180, "z": 0 },
    "env": { "hdr": "potsdamer_platz_1k", "intensity": 1, "exposure": 1, "rotation": 0 },
    "lights": { "key": 1, "fill": 0.45, "rim": 0.35 },
    "animation": { "clip": null, "speed": 1, "loop": "loop", "offset": 0 },
    "shadow": { "enabled": false, "opacity": 0.35, "blur": 1 }
  } }
```

For a custom model use `"source": "custom", "preset": null` and point the clip `url` at the uploaded file.

**Primitive shapes** block out a set: grey (or tinted) stand-ins to place, light and film before the real objects exist — and what the Scene Rig's AI video sends to the model as the shot to re-create.

```json
// clip
{ "id": "p1", "source": "LOCAL", "mediaType": "model3d",
  "url": "model-primitive:cube", "proxyUrl": null, "name": "Cube", "duration": 6 }
// item — the rest of model3dConfig is the same as for any model
{ "id": "pi1", "clipId": "p1", "trimStart": 0, "trimEnd": 6, "panX": 12, "panZ": 0,
  "model3dConfig": { "source": "primitive",
    "primitive": { "kind": "cube", "color": "#4f86ff", "text": "TEXT" },
    "fit": "height", "fitValue": 24, "anchor": "center", "placeOnRigFloor": true,
    "baseRotation": { "x": 0, "y": 0, "z": 0 } } }
```

| Field | Values | Default | Notes |
| --- | --- | --- | --- |
| `primitive.kind` | `cube`, `sphere`, `card`, `torus`, `cone`, `cylinder`, `human`, `car`, `text` | `cube` | An unknown kind loads as `cube`. Keep the clip url's `<kind>` the same. |
| `primitive.color` | any CSS colour, ≤ 64 chars | `#d9d9d9` | Tints the whole shape (the car's glass and tyres keep their own colour). |
| `primitive.text` | string, ≤ 40 chars | `TEXT` | Only read by `kind: "text"` (extruded letters). |

On a floor-bearing rig, `placeOnRigFloor: true` stands the shape on the cyclorama; `panX` (% of comp width) and `panZ` (px, + toward the camera) place it on the floor. Fit values the editor uses for a set at comp scale: cube/sphere 24, card 26, torus 22, cone/cylinder 28, human 58, car 20, text 14. Keep `source`/`preset` consistent with the clip url: the renderer resolves the asset from `model3dConfig` first (`source: "preset"` + a valid `preset` id wins), then falls back to the clip's sentinel/url — but the clip url is what keeps the clip **alive** on load, so always set both sides to the same device.

**Bundled device presets:**

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

`iphone_17` is an alias of `iphone_pro_max`: it loads the same model, so it also needs `baseRotation.y: 180`. Write `iphone_pro_max`.

Some GLBs are authored facing away from the viewer — for those, set `baseRotation.y: 180` (the last column; the editor sets it when it adds the layer). A wrong value shows the device's back.

**`model3dConfig` fields** (out-of-range values are clamped, unknown enum values fall back to the default):

| Field | Values / range | Default | Meaning |
| --- | --- | --- | --- |
| `source` | `"preset"` \| `"primitive"` \| `"custom"` | `custom` | Where the geometry comes from. Anything else coerces to `custom`. |
| `preset` | preset id string | `null` | Required when `source: "preset"`. An unknown id falls through to the clip url. |
| `fit` | `"height"` \| `"width"` \| `"unit"` | `height` | How `fitValue` sizes the model: % of frame height, % of frame width, or raw pixels-per-model-unit. |
| `fitValue` | `0.01–10000` | `60` | With `fit: "height"`, `60` = the model's bounding box spans 60 % of the frame height. |
| `anchor` | `"center"` \| `"base"` \| `"origin"` | `center` | Pivot: bbox centre, bbox floor (for objects standing on a surface), or the asset's own origin — no recentring, so a GLB exported in scene coordinates (Blender → GLEA) lands exactly where its scene put it, whatever its rest pose. |
| `placeOnRigFloor` | bool | `true` | With a floor-bearing Scene Rig, place the model's real post-transform lower bound on the cyclorama floor. The ordinary Y transform becomes an offset from that floor. Set `false` for free/flying placement. |
| `physics` | `"off"` \| `"falls"` \| `"solid"` | `off` | Rigid-body physics, only in a 3D Scene (Rigid bodies (GreenLight Dash only)): `falls` makes the model a rigid body that falls, hits and stacks from where the layer stands; `solid` a fixed one others hit. The classic renderer ignores it. |
| `castShadow` | bool | `true` | With a Scene Rig casting real shadows: the model is in the shadow map. `false` = it casts nothing (a huge set piece that should only receive). Blended parts of a model (glTF BLEND — a baked contact-shadow card, a glow) never cast either way. Only stored when `false`. |
| `receiveShadow` | bool | `true` | With a Scene Rig: rig shadows darken the model. `false` = they never land on it. Only stored when `false`. |
| `baseRotation` | `{x,y,z}` deg, `±360` | `{0,0,0}` | Static orientation applied before keyframed rotation. |
| `env.hdr` | see list below | `potsdamer_platz_1k` | Image-based lighting environment (reflections + ambient). |
| `env.intensity` | `0–5` | `1` | Environment light strength. |
| `env.exposure` | `0.05–8` | `1` | Tone-mapping exposure of the model pass. |
| `env.rotation` | `±360` deg | `0` | Spins the environment (moves reflections). |
| `lights.key/fill/rim` | `0–10` each | `1 / 0.45 / 0.35` | The three directional lights' intensities. **Accepted, normalised on read** — see "Scene Rig" below. Still the right shape to emit when a project has no rig layer; ignored on every model once one exists. |
| `animation.clip` | glTF animation name \| `"*"` \| `null` | `null` | Plays the named animation baked into the asset; `"*"` plays EVERY clip together, each on its own length (Blender's exporter writes one clip per animated object); `null` = static. Names must match the glTF exactly. `loop: "once"` holds the last frame. A machine running or a device coming apart is made as such a GLB: mechanisms.md (GreenLight Dash only). |
| `animation.speed` | `-8–8` | `1` | Playback rate (negative = reversed). |
| `animation.loop` | `"once"` \| `"loop"` \| `"pingpong"` | `loop` | Loop mode. |
| `animation.offset` | `±600` s | `0` | Start offset into the animation. |
| `shadow.enabled` | bool | `false` | Soft contact-shadow blob under the model. |
| `shadow.opacity` | `0–1` | `0.35` | Shadow strength. |
| `shadow.blur` | `0–10` | `1` | Shadow softness. |
| `screen` | object, optional | absent | Artwork on a preset device's display — see below. |

`env.hdr` options: `potsdamer_platz_1k` (City), `studio_small_03_1k` (Studio), `lebombo_1k` (Apartment), `kiara_1_dawn_1k` (Dawn), `venice_sunset_1k` (Sunset), `dikhololo_night_1k` (Night), `forest_slope_1k` (Forest), `rooitou_park_1k` (Park), `st_fagans_interior_1k` (Lobby), `empty_warehouse_01_1k` (Warehouse).

**Screen artwork (preset devices).** `model3dConfig.screen` puts an image or video on the device's display, using the same pipeline as the Mockup builder: `{ "url": "<media url>", "scale": 1 (0.1–5), "offsetX": 0, "offsetY": 0 (±1), "rotation": 0 (±180°), "padding": 0 (0–0.45), "fitMode": "cover"|"contain", "borderRadius": 0 (0–0.5) }`. Only stored when `url` is set; dropped when switching a layer to `source: "custom"`.

**Media on any model's own meshes — `model3dConfig.screens`.** Up to 8 entries, each putting an image or a video on the meshes whose node name (`node`) or first material name (`material`) matches — a slab showing a live UI, a TV, a poster, a phone inside a scene, on custom GLBs and presets alike:

```jsonc
"screens": [{
  "material": "UI_panel",            // or "node": "Screen_mesh"
  "url": "/media/admin/{board_id}/screen.mp4",
  "fitMode": "stretch",              // stretch (fill the mesh's own UVs — default) | cover | contain
  "aspect": 1.7778,                  // canvas aspect for cover/contain (default 16:9)
  "uv": "mesh",                      // mesh = the glTF UVs | planar = projected over the mesh's two largest axes
  "shading": "screen",               // screen = self-lit, exact colours | lit = takes the set's light, shadows, reflections and still glows
  "receiveShadow": true,             // screen only: Scene Rig shadows still fall on it (colours stay exact elsewhere). Default off
  "offset": 0, "loop": true,         // video: seconds into the media at the layer's first frame; loop or hold the last frame
  "mirrorX": false, "flipY": false,  // UV fixes for oddly authored meshes (glTF UV origin is top-left)
  "scale": 1, "offsetX": 0, "offsetY": 0, "rotation": 0, "padding": 0, "borderRadius": 0
}]
```

A `screen`-shaded mesh shows the media in **its own colours**: its pixels skip the 3D tone curve (a depth-tested coverage mask, so anything in front still hides it), so a UI on a slab matches the same file as a 2D layer. Being self-lit it takes no light — and so no shadow: a character walking on a page or a UI looks as if it floats. Set `receiveShadow: true` on such a screen and the Scene Rig's real shadows darken it where they land (by the casting lights' share of the set's light), while every other pixel keeps the media's exact colours. Use it for any screen something stands on or passes over. Videos are driven by the layer clock and are **frame-exact in exports and stills** for MP4/MOV (the device `screen` uses the same path). WebM falls back to a seeked `<video>` (best effort).

**Transforms & keyframes.** The item's ordinary transform fields and `propertyKeyframes` (`scale`, `xPercent`/`yPercent`, `translateZ`, `rotateX`/`rotateY`/`rotate`, `opacity`, …) are applied **inside the 3D pass** — a keyframed `rotateY` really orbits the object in 3D rather than spinning a flat card. The project camera films model layers like everything else (`cameraLocked` on the channel opts out).

**Look.** The 3D pass is tone-mapped with **AgX** (the curve Blender renders with) plus a GLEA look (×1.35 gain and 1.2 saturation) in its own pass, so models, the Scene Rig and real-3D effects share one filmic curve while 2D layers are untouched. A 3D Scene takes its film look from `rig.look` and `rig.exposure` (world3d.md (GreenLight Dash only)).

**Rendering.** Model layers render in the editor preview, the desktop Download, **`/render-onserver`** / **`/render-onserver-job`**, and **`/render-still`**. The fast `/render` does **not** support them (video/image only). Very heavy assets (≳900 k triangles) render slowly enough that an export can look hung — prefer decimated models.

### Scene Rig — one set for every 3D layer

> **Every Rig is a 3D Scene**, drawn by the world renderer unless `rig.renderer` is `"classic"` (or the machine has no WebGPU, below): the backdrop, the Rig's lights and environment and the model layers become one lit, shadowed world, path traced in Final 3D, and you can build in it yourself, with no Blender, by writing `rig.scene` (world3d.md (GreenLight Dash only)). The fields below hold in both; where the world reads them differently, the section says so.

A **rig** clip carries the project's lights, backdrop and environment. It is a singleton, like the camera: `mediaType: "rig"` on a channel with `kind: "rig"`, and the item carries `item.rig`. **When a rig exists it lights every model layer** and `model3dConfig.lights` is ignored; with no rig, each model keeps its own three lights. Adding a rig is therefore additive — it never changes an existing project until you add one.

```jsonc
"rig": {
  "cyclorama": {
    "shape": "cyc",              // cyc|floor|wall|corner|room|cylinder|dome|disc|none
    "width": 4, "height": 2.25, "depth": 3,   // MULTIPLES OF COMP HEIGHT, not px
    "curve": 0.35,               // floor→wall sweep, as a fraction of height
    "x": 0, "y": 0, "z": 0, "rotX": 0, "rotY": 0, "rotZ": 0, "scale": 1,
    "material": { "mode": "solid",  // solid | shadowCatcher | image (a picture, `imageUrl`)
                  "color": "#d8d8d8", "roughness": 0.8,
                  "metalness": 0, "opacity": 1,
                  "receiveShadow": true, "castShadow": false }
  },
  "lights": [                    // max 8; placement is SPHERICAL, not cartesian
    { "lid": "k", "type": "directional", "name": "Key", "on": true,
      "color": "#ffffff", "intensity": 1, "az": 40, "elev": 42, "dist": 3000 },
    { "lid": "a", "type": "ambient", "name": "Ambient",
      "color": "#ffffff", "intensity": 0.15 }
  ],
  "env": { "source": "preset",   // preset | custom | none
           "preset": "studio_small_03_1k", "url": null,
           "intensity": 1, "exposure": 1, "rotX": 0, "rotY": 0, "rotZ": 0 },
  "shadows": { "mode": "map", "maxCasters": 2 }   // off | contact | map
}
```

**Which renderer draws it.** On a machine with WebGPU, every Rig is drawn by the **world renderer** (world3d.md (GreenLight Dash only)) unless `rig.renderer` is `"classic"`; without WebGPU it falls back to the classic Rig passes. Both read the same `rig`, with these differences:

- The world renderer ignores the `shadows` block (`mode`, `maxCasters`) and a light's `shadowBias`, `shadowNormalBias` and `shadowMapSize`: a light casts when its own `castShadow` is true. The shadow-map paragraphs below (**Shadows**, **The shadow map follows the camera**, the area light's companion caster) describe the classic renderer.
- `shadowSoftness` is the light's size in the world renderer (see the light fields below); in the classic renderer it widens the shadow-map penumbra.

**Shadows (classic renderer).** `mode: "map"` gives real shadow maps: a model casts onto the cyclorama and
onto other models. A light only casts when it ALSO has `castShadow: true` — the mode
alone does nothing. `maxCasters` (0-4, default 2) caps how many casting lights are
honoured, because each one is a full extra render of the set every frame; lights past
the cap are silently not casting, in array order. The cyclorama receives by default
(`cyclorama.material.receiveShadow`) and does not cast. `mode: "contact"` keeps only
the cheap soft blob under each model standing on the rig floor (`placeOnRigFloor`).
A rig you write gets exactly what you write. In a 3D Scene none of this applies: every light with
`castShadow: true` casts (see **Which renderer draws it** above).

**The shadow map follows the camera (classic renderer).** Each frame a casting light's map is fitted to
what the camera actually sees of the set (the frustum clipped to the receivers, in the
casters' reach), in 1/8-octave size steps with a texel-snapped centre so a moving
camera does not make shadow edges crawl. A small character on a long set (a ten-metre
page) therefore gets shadows as crisp as on a small one — there is no need to move the
cast to a steeper light or to shrink the set. Shadow acne is handled automatically
(per-texel offsets plus receiver-plane depth bias in the soft-shadow filter); a light can
override it with `shadowBias` / `shadowNormalBias` (0–20, in texels of its map; leave
them out for automatic — raise them if a surface still shows stripes, lower them if a
shadow looks detached).

**One shared world, but only when a rig exists.** With `renderer: "classic"`, every 3D
layer is placed in one scene so the shadow map can contain every caster, and each layer
still renders in its own pass, so opacity, blend modes, masks, effects and DOF are
unchanged. In a 3D Scene the world draws the models, and a model it draws takes no
`opacity` or `blendMode`. With NO rig, each model keeps its own scene and its own
`model3dConfig.env`, which is why adding a rig to an existing project is additive and
never re-lights it by surprise. With a rig, the rig's `env` (and exposure) is the one in
effect for every model; key `sc:env:intensity` to change reflections over time (e.g.
only once a metal object takes the stage). A 3D Scene turns its environment by `rotY`
alone.

**Camera depth of field is per pixel on 3D passes** (a model, the cyclorama, an occluding shadow plate), so a whole set, backdrop included, can live in one model layer; each pixel blurs by a radius in px: [video-camera.md](video-camera.md#depth-of-field).

**Light types and their fields.** Every light has `lid`, `type`, `name`, `on`, `color` and `intensity` (0–100, default 1). `directional` / `point` / `spot` / `area` also take `az` (±360°), `elev` (±90°), `dist` (0–100000 world px, default 3000), `castShadow` (default false; obeyed in Draft and Final on every kind of light: leave it off on a fill, or it throws a second shadow) and `shadowSoftness` (0–10, default 1); `ambient` and `hemisphere` take neither. `spot` adds `angle` (1–89°, default 32) and `penumbra` (0–1, default 0.5); `point` adds `range` (world px, default 0) and `decay` (0–4, default 2, the falloff exponent); `area` adds `width` × `height` (world px, default 800 × 800) and `spread` (below); `spot` and `area` aim at `targetX` / `targetY` / `targetZ` (world px, default the rig origin); `hemisphere` adds `groundColor`. Fields a type does not have are dropped on load.

- **`castShadow`** — a fill leaves it off, or it throws a second shadow.
- **`shadowSoftness`** — in the world renderer it is the light's size, and the subject stays as bright: a directional light becomes a sun `1 + 2 × shadowSoftness` degrees wide, an area light's panel is scaled by it, and a spot or point lamp grows with it and with its distance. In the classic renderer a casting light's `shadowSoftness` widens its penumbra, scaled by the light's distance — contact points stay sharp and the shadow softens away from them.
- **`spread`** (area only, 1–180, default 180) narrows a panel to a pool of light, like a grid on a soft box. The subject stays as bright. Stored only below 180.
- **`texture`** (on `directional`, `spot` and `area`) is what the light shines through: `{ "pattern": "window" }` (or `blinds`, `leaves`), or an image of the user's: `{ "url": "/media/…/gobo.png", "name": "gobo.png" }`. A spot projects it in colour, in Draft and Final. A directional and an area light cast the pattern from something out of frame. An image on an area light sits on the panel itself, so it shows in reflections in Final and tints the set in Draft.

**`area` — a softbox.** A lit rectangle of `width` × `height` world px at its spherical position, facing its target: broad, soft highlights and soft wrap-around light, the way a large source lights in Blender or a studio — use it for keys and fills on products, glossy and metal surfaces. Bigger at the same `intensity` = the same light on the subject, only softer. In the classic renderer it has no shadow map of its own: with `castShadow: true` a companion light from the same place carries half its light and casts the shadow (a lighter, softer shadow, as from a large source), and counts against `shadows.maxCasters`; match the softness to the box there with `shadowSoftness` ≈ (box size / distance to the target) ÷ 0.22.

**`intensity` means the same on every light: what the set receives.** A `point` or `spot` of `2` at `dist: 2400` (or an `area` of `2` at any size, at its target) lights the subject at the centre of the set like a `directional` of `2`, then falls off physically around it (closer is brighter, farther darker).

**`lid`** matches `/^[A-Za-z0-9_-]{1,12}$/` and must be unique within the rig — it is the key keyframe tracks address.

**Sizes are multiples of composition height**, so a rig authored at 1080p is correct at 4K with no migration. `width: 4` on a 1080-tall comp is 4320 world px.

**Switch a light off with `intensity: 0` or `on: false`, never by removing it.** The light count is a compiled shader constant, so changing it recompiles every material in the scene. `on: false` turns the light off the same way and keeps its `intensity` for later.

**Cyclorama shape `"none"`** draws nothing: use it for a rig that only carries lights. Any other shape with `material.mode: "solid"` writes depth, so layers behind it are cut by its surface.

**`material.mode: "image"`** with `material.imageUrl` (a media url) puts a picture on the backdrop in the world renderer; the picture is multiplied by `color`, so leave `color` white to show its own colours. The classic renderer does not read `imageUrl`.

**`material.mode: "shadowCatcher"`** keeps only the shadows the set receives and is transparent everywhere else, for models standing on the composition `background`. It writes no depth, so it never cuts a layer. Its shadows use `material.shadowColor` (default `#000000`), not `color` — `color` stays the Solid surface's colour, so a paper set switched to shadows does not paint them in the paper's own colour. `opacity` is the shadow strength (0-1), and the backdrop colour track `scc:cyc:col` drives `shadowColor` in this mode.

**Rig keyframes** live on the rig item's `propertyKeyframes` under two prefixes (`sc:` numeric, `scc:` colour — the prefix alone decides numeric vs RGBA interpolation):

| Key | Range |
| --- | --- |
| `sc:<lid>:intensity` | 0–100 |
| `sc:<lid>:az` \| `elev` \| `dist` \| `shadowSoftness` | per the fields above; not on `ambient` / `hemisphere` |
| `sc:<lid>:angle` \| `penumbra` | spot only |
| `sc:<lid>:width` \| `height` \| `spread` | area only (world px; spread in degrees) |
| `scc:<lid>:col` | colour |
| `sc:cyc:x` \| `y` \| `z` \| `rotX` \| `rotY` \| `rotZ` \| `scale` \| `opacity` | — |
| `scc:cyc:col` | colour |
| `sc:env:intensity` \| `exposure` \| `rotX` \| `rotY` \| `rotZ` | — |

**Refused, and dropped on load:** light `type`, adding/removing a light, `castShadow`, `shadowMapSize`, cyclorama `shape` and dimensions, `env.source`/`preset`/`url`. Each is a shader recompile or an environment re-bake, not a value — animating one would rebuild every frame. A track naming a `lid` that no longer exists is dropped on the next save.

**The playhead outside every rig clip does NOT mean darkness.** The nearest rig still lights the scene, and a project with no rig falls back to the default three directional lights.

**24 built-in presets**, each a **complete** rig — applying one replaces `item.rig` wholesale:

| Category | Preset ids |
| --- | --- |
| Studio | `threePoint` (the same lights as a project with no rig — use it to match one), `studioRoom`, `clamshellBeauty`, `highKeyWhite` |
| Product | `productSoftbox`, `topDownProduct`, `turntable`, `pastelSweep`, `pianoBlack`, `cosmeticGlow`, `windowFlatlay` |
| Dramatic | `rimLitDark`, `filmNoir`, `stageSpotlight`, `campfireGlow`, `rimHero` |
| Daylight | `sunsetWindow`, `overcastExterior`, `desertNoon`, `blueHour` |
| Location | `warehouse`, `sciFiRoom` |
| Stylized | `neonTwoTone`, `duotonePop` |

**Other rig-item fields the editor writes.** `item.rigLook = { id, name, hash }` records which look was applied (a preset id, or `saved:<id>` for a look the user saved) and a hash of the rig at that moment, so the editor can mark the look as edited once the rig drifts from it. It is informational — omit it when emitting a rig; a hand-made `hash` never matches, so the look would show as edited from the start. `item.rigAi` holds the AI video state — the prerender used as the source, the takes and which one is placed on the timeline. It is written by the editor from real render and generation results; do not write it yourself.

### Turning flat layers in 3D — pivot and stacking

**The pivot.** Every flat layer (image, video, shape, text, html clip) turns in 3D
with the static `rotateX` / `rotateY` / `rotateZ` fields and the `rotateX` / `rotateY` / `rotate` keyframe tracks alike: a static angle and the
same angle reached by a key give the same pose, and mixing static and keyed channels never moves the layer. The
pivot is `keyframeTransformOrigin` (`"center"` default; `"top"`, `"bottom"`, `"left"`, `"right"`, the four
corners such as `"bottom left"`, or CSS-style `"50% 100%"`): rotation and the keyed `scale` / `scaleX` / `scaleY`
turn and grow about that point of the layer's own box (the drawn plate; for text, the laid-out block). `panX` /
`panY` / `panZ` keep placing the layer's centre as it rests unrotated, and the static `zoom` sizes it about that
centre. So a card that stands up off a page is placed **flat**, with `keyframeTransformOrigin: "bottom"` and
`rotateX` 0 → −90 keyed (or static −90): its bottom edge stays on the line it lay on, and a keyed `scaleY` 0 → 1
with the card already standing grows it up out of that line. No translate arc is needed.

**Stacking.** Without a model in the frame, flat layers composite back to front (painter's order). A layer turned
in 3D is ordered against every flat layer it does not cross by which side of that layer's plane it stands on, so
a card standing on a page or floor layer always draws over it, wherever the camera looks. Two layers that cut
through each other still need `shadowPlate.occludes` (below) to intersect per pixel.

### Flat layers in the 3D scene — `item.shadowPlate`

`text`, `shape`, `image` and `video` items can join the 3D scene without becoming
solids. The layer stays flat and keeps its normal renderer, so text animators, shape and
video animation stay native and its alpha updates every frame.

```jsonc
"shadowPlate": { "castShadow": false, "receiveShadow": false, "occludes": false }
```

All three default to `false` and are independent — omit the block entirely for an
ordinary 2D layer. The field is ignored on any other media type.

- **`occludes`** — the layer's visible pixels take part in the frame's depth buffer, so
  it intersects models and other `occludes` layers **per pixel** instead of stacking
  wholly in front or behind. Needs no rig. The layer is not re-rendered, so its
  position, blend mode, Motion Blur, Rig (Puppet) and 3D Depth are all unaffected. Use
  `panZ` (and `rotateX`/`rotateY`) to place it in depth; two layers at the same `panZ`
  are coplanar and will not visibly cross.
- **`castShadow`** — the layer's live silhouette is added to the rig's shadow map, so it
  drops a shadow on models and on the cyclorama. Needs a rig with
  `shadows.mode: "map"` and at least one light with `castShadow: true`. The layer's own
  pixels are untouched. A 3D Scene's world takes no flat silhouette, so there a scene
  object or a model layer has to cast the shadow.
- **`receiveShadow`** — the set's shadows fall across the layer. This is the only one
  that re-films the layer inside the lit scene, so **Motion Blur, Rig (Puppet) and 3D
  Depth are unavailable on that layer** while it is on; the other two leave them
  working.
