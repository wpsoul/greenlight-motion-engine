> **GreenLight Motion Engine:** this is the GreenLight Dash Video Editor's project format, which the engine reads as is.
> Ignore the `/api/...` routes and the app UI described here: in the engine you edit `project.json` and run
> `npx greenlight-motion build`. MotionFast templates (`mediaType: "motion"`) stay in GreenLight Dash.

# GreenLight Dash — 3D models, scene lighting and shadow plates

> Read [video-projects.md](video-projects.md) for the shared project, clip, channel, timing and versioned-write contracts. Load only the sections needed for the task.

## Contents

- [3D model layers (`mediaType: "model3d"`) — a live GLB/GLTF/OBJ rendered per frame](video-3d.md#3d-model-layers-mediatype-model3d--a-live-glbgltfobj-rendered-per-frame)
- [Scene Rig — one set for every 3D layer](video-3d.md#scene-rig--one-set-for-every-3d-layer)
- [Flat layers in the 3D scene — `item.shadowPlate`](video-3d.md#flat-layers-in-the-3d-scene--itemshadowplate)

### 3D model layers (`mediaType: "model3d"`) — a live GLB/GLTF/OBJ rendered per frame

Unlike a device mockup (pre-baked to a video file), a `model3d` layer is a **real 3D scene rendered live every frame** by the Player (three.js, its own depth-buffered pass), then composited like any other layer. The model can be one of the bundled device presets or a custom uploaded asset, and it participates in the project camera, keyframes, layer parenting and effects like any layer.

**⚠ The clip `url` must NEVER be empty — an empty url silently deletes the layer.** `sanitizeClip` (VideoEditor.jsx) treats a `model3d` clip like a video clip: no `url` → the clip is dropped on load/render, and every timeline item referencing it is dropped with it. Nothing errors — the project saves fine and a headless render completes "successfully" with the model simply missing from every frame. This happens even when the item carries a complete, valid `model3dConfig`. The two valid url forms:

- **Preset device:** `"url": "model-preset:<presetId>"` — a stable sentinel, NOT a fetchable path. (The bundled .glb's real URL is a content-hashed build artifact that changes every release; the sentinel survives app updates.)
- **Primitive shape:** `"url": "model-primitive:<kind>"` — a stand-in built in code, no asset file. Pair it with `"source": "primitive"` and `"primitive": { "kind", "color", "text" }` in `model3dConfig` (see below).
- **Custom model:** a real uploaded asset URL ending in `.glb`, `.gltf` or `.obj` (upload via the media API, then use the returned `/media/...` url).

**Clip + item pair (preset device):**

```json
// clip — url is the preset sentinel, source REMOTE, no proxy/thumbnail
{ "id": "m1", "source": "REMOTE", "mediaType": "model3d",
  "url": "model-preset:iphone_17", "proxyUrl": null, "name": "iPhone 17", "duration": 4 }
// item — model3dConfig holds everything about fit, look and animation
{ "id": "mi1", "clipId": "m1", "trimStart": 0, "trimEnd": 4,
  "model3dConfig": {
    "source": "preset", "preset": "iphone_17",
    "fit": "height", "fitValue": 60, "anchor": "center", "placeOnRigFloor": true,
    "baseRotation": { "x": 0, "y": 0, "z": 0 },
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

On a floor-bearing rig, `placeOnRigFloor: true` stands the shape on the cyclorama; `panX` (% of comp width) and `panZ` (px, + toward the camera) place it on the floor. Fit values the editor uses for a set at comp scale: cube/sphere 24, card 26, torus 22, cone/cylinder 28, human 58, car 20, text 14. Keep `source`/`preset` consistent with the clip url: the renderer resolves the asset from `model3dConfig` first (`source: "preset"` + a valid `preset` id wins), then falls back to the clip's sentinel/url — but the clip url is what keeps the clip **alive** through sanitization, so always set both sides to the same device.

**Bundled device presets** (`MODEL_PRESETS` in `frontend/src/components/videoEditor/model3dPresets.js`):

| `preset` id | Device | Screen artwork | `baseRotation.y` to face the camera |
| --- | --- | --- | --- |
| `iphone_pro_max` | iPhone 17 Pro Max | yes | `180` |
| `iphone_17` | iPhone 17 | yes | `0` |
| `iphone_air` | iPhone Air | yes | `0` |
| `double_iphone` | Two iPhones | yes | `180` |
| `ipad` | iPad | yes | `0` |
| `ipad_mini` | iPad mini | yes | `180` |
| `macbook_pro` | MacBook Pro | yes | `0` |
| `macbook_air` | MacBook Air | yes | `0` |
| `imac` | iMac | yes | `180` |

Some GLBs are authored facing away from the viewer — for those, set `baseRotation.y: 180` (the last column; the editor's Add-Layer flow applies this automatically via `presetBaseRotation`). A wrong value shows the device's back.

**`model3dConfig` fields** (sanitized by `sanitizeModel3dConfig` in `editorState.js`; defaults in `MODEL_CONFIG_DEFAULTS` in `types.js` — out-of-range values are clamped, bad enums fall back):

| Field | Values / range | Default | Meaning |
| --- | --- | --- | --- |
| `source` | `"preset"` \| `"custom"` | `custom` | Where the geometry comes from. Anything else coerces to `custom`. |
| `preset` | preset id string | `null` | Required when `source: "preset"`. An unknown id falls through to the clip url. |
| `fit` | `"height"` \| `"width"` \| `"unit"` | `height` | How `fitValue` sizes the model: % of frame height, % of frame width, or raw pixels-per-model-unit. |
| `fitValue` | `0.01–10000` | `60` | With `fit: "height"`, `60` = the model's bounding box spans 60 % of the frame height. |
| `anchor` | `"center"` \| `"base"` \| `"origin"` | `center` | Pivot: bbox centre, bbox floor (for objects standing on a surface), or the asset's own origin — no recentring, so a GLB exported in scene coordinates (Blender → GLEA) lands exactly where its scene put it, whatever its rest pose. |
| `placeOnRigFloor` | bool | `true` | With a floor-bearing Scene Rig, place the model's real post-transform lower bound on the cyclorama floor. The ordinary Y transform becomes an offset from that floor. Set `false` for free/flying placement. |
| `castShadow` | bool | `true` | With a Scene Rig casting real shadows: the model is in the shadow map. `false` = it casts nothing (a huge set piece that should only receive). Blended parts of a model (glTF BLEND — a baked contact-shadow card, a glow) never cast either way. Only stored when `false`. |
| `receiveShadow` | bool | `true` | With a Scene Rig: rig shadows darken the model. `false` = they never land on it. Only stored when `false`. |
| `baseRotation` | `{x,y,z}` deg, `±360` | `{0,0,0}` | Static orientation applied before keyframed rotation. |
| `env.hdr` | see list below | `potsdamer_platz_1k` | Image-based lighting environment (reflections + ambient). |
| `env.intensity` | `0–5` | `1` | Environment light strength. |
| `env.exposure` | `0.05–8` | `1` | Tone-mapping exposure of the model pass. |
| `env.rotation` | `±360` deg | `0` | Spins the environment (moves reflections). |
| `lights.key/fill/rim` | `0–10` each | `1 / 0.45 / 0.35` | The three directional lights' intensities. **Accepted, normalised on read** — see "Scene Rig" below. Still the right shape to emit when a project has no rig layer; ignored on every model once one exists. |
| `animation.clip` | glTF animation name \| `"*"` \| `null` | `null` | Plays the named animation baked into the asset; `"*"` plays EVERY clip together, each on its own length (Blender's exporter writes one clip per animated object); `null` = static. Names must match the glTF exactly. `loop: "once"` holds the last frame. |
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

A `screen`-shaded mesh shows the media in **its own colours**: its pixels skip the 3D tone curve (a depth-tested coverage mask, so anything in front still hides it), so a UI on a slab matches the same file as a 2D layer. Being self-lit it takes no light — and so no shadow: a character walking on a page or a UI looks as if it floats. Set `receiveShadow: true` on such a screen and the Scene Rig's real shadows darken it where they land (by the casting lights' share of the set's light), while every other pixel keeps the media's exact colours. Use it for any screen something stands on or passes over. Videos are driven by the layer clock and are **frame-exact in exports and stills** for MP4/MOV (WebCodecs decoder lanes, settled before each frame is encoded; the device `screen` uses the same path). WebM falls back to a seeked `<video>` (best effort). The inspector's SCREEN section lists the entries and removes them; agents write them.

**Transforms & keyframes.** The item's ordinary transform fields and `propertyKeyframes` (`scale`, `xPercent`/`yPercent`, `rotateX`/`rotateY`/`rotateZ`, `panZ`, opacity, …) are applied **inside the 3D pass** — a keyframed `rotateY` really orbits the object in 3D rather than spinning a flat card. The project camera films model layers like everything else (`cameraLocked` on the channel opts out).

**Look.** The 3D pass is tone-mapped with **AgX** (the curve Blender renders with; three.js r183's AgXToneMapping) plus a GLEA look — ×1.35 gain so mid-grey sits where the earlier ACES default had it, and 1.2 saturation — in its own pass, so models, the Scene Rig, World View and real-3D effects share one filmic curve while 2D layers are untouched. It replaced the earlier ACES fit as the default.

**Rendering.** Model layers render in the editor preview, the desktop Download, **`/render-onserver`** / **`/render-onserver-job`**, and **`/render-still`**. The fast `/render` does **not** support them (video/image only). Very heavy assets (≳900 k triangles) render slowly enough that an export can look hung — prefer decimated models.

### Scene Rig — one set for every 3D layer

A **rig** clip carries the project's lights, backdrop and environment. It is a singleton, like the camera: `mediaType: "rig"` on a channel with `kind: "rig"`, and the item carries `item.rig`. **When a rig exists it lights every model layer** and `model3dConfig.lights` is ignored; with no rig, each model keeps its own three lights exactly as before. Emitting a rig is therefore additive — it never changes an existing project until you add one.

```jsonc
"rig": {
  "cyclorama": {
    "shape": "cyc",              // cyc|floor|wall|corner|room|cylinder|dome|disc|none
    "width": 4, "height": 2.25, "depth": 3,   // MULTIPLES OF COMP HEIGHT, not px
    "curve": 0.35,               // floor→wall sweep, as a fraction of height
    "x": 0, "y": 0, "z": 0, "rotX": 0, "rotY": 0, "rotZ": 0, "scale": 1,
    "material": { "mode": "solid",  // solid | shadowCatcher
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

**Shadows.** `mode: "map"` gives real shadow maps: a model casts onto the cyclorama and
onto other models. A light only casts when it ALSO has `castShadow: true` — the mode
alone does nothing. `maxCasters` (0-4, default 2) caps how many casting lights are
honoured, because each one is a full extra render of the set every frame; lights past
the cap are silently not casting, in array order. The cyclorama receives by default
(`cyclorama.material.receiveShadow`) and does not cast. `mode: "contact"` keeps only
the cheap soft blob under each model standing on the rig floor (`placeOnRigFloor`).
A Scene Rig added in the editor starts with `mode: "map"` and only the Key light
(`k1`) casting; a rig you write yourself gets exactly what you write.

**The shadow map follows the camera.** Each frame a casting light's map is fitted to
what the camera actually sees of the set (the frustum clipped to the receivers, in the
casters' reach), in 1/8-octave size steps with a texel-snapped centre so a moving
camera does not make shadow edges crawl. A small character on a long set (a ten-metre
page) therefore gets shadows as crisp as on a small one — there is no need to move the
cast to a steeper light or to shrink the set. Shadow acne is handled automatically
(per-texel offsets plus receiver-plane depth bias in the soft-shadow filter); a light can
override it with `shadowBias` / `shadowNormalBias` (0–20, in texels of its map; leave
them out for automatic — raise them if a surface still shows stripes, lower them if a
shadow looks detached).

**One shared world, but only when a rig exists.** With a rig, every 3D layer is placed
in one scene so the shadow map can contain every caster; each layer still renders in
its own pass, so opacity, blend modes, masks, effects and DOF are unchanged. With NO
rig, each model keeps its own scene and its own `model3dConfig.env` — which is why
adding a rig to an existing project is additive and never re-lights it by surprise.
With a rig, the rig's `env` (and exposure) is the one in effect for every model;
key `sc:env:intensity` to change reflections over time (e.g. only once a metal
object takes the stage).

**Camera depth of field is per pixel on 3D passes.** A model, a cyclorama or an
occluding shadow plate hands the compositor its depth buffer, and every pixel blurs by
the CoC of its OWN distance (`camAperture · |camFocusDistance − d| / d · camBlurLevel/100`,
capped at 64 px, still held off inside the focus area) — a character in focus stays
sharp in the same model as a wall metres behind it. The gather is depth-aware: a
blurred background never smears over a sharp foreground edge, a sharp foreground
leaves no halo on the blurred background, and a foreground in front of the focus plane
blurs out over what is behind it and past its own silhouette. Taps read the picture
prefiltered (mip level of the tap spacing), so thin bright detail under a wide blur —
lettering far behind the focus — averages instead of sparkling; 2D layers get the same.
A whole set (backdrop included) can therefore live in one model layer. Flat 2D layers
keep one CoC per layer — the depth of their plane.

**Light types and their fields.** `directional` / `point` / `spot` / `area` take `az` (±360°), `elev` (±90°), `dist` (world px); `ambient` and `hemisphere` take neither. `spot` adds `angle` (1–89°) and `penumbra` (0–1); `spot` and `area` aim at `targetX` / `targetY` / `targetZ` (world px, default the rig origin); `hemisphere` adds `groundColor`. Fields a type does not have are dropped by the sanitizer.

**`area` — a softbox.** A lit rectangle of `width` × `height` world px (default 800 × 800) at its spherical position, facing its target: broad, soft highlights and soft wrap-around light, the way a large source lights in Blender or a studio — use it for keys and fills on products, glossy and metal surfaces. Bigger at the same `intensity` = the same light on the subject, only softer. It has no shadow map of its own: with `castShadow: true` a companion light from the same place carries half its light and casts the shadow (a lighter, softer shadow, as from a large source), and counts against `shadows.maxCasters`. Set the softness to match the box: `shadowSoftness` ≈ (box size / distance to the target) ÷ 0.22.

**`intensity` means the same on every light: what the set receives.** A `point` or `spot` of `2` at `dist: 2400` (or an `area` of `2` at any size, at its target) lights the subject at the centre of the set like a `directional` of `2`, then falls off physically around it (closer is brighter, farther darker). A casting light's `shadowSoftness` (0–10, default 1) widens its penumbra, scaled by the light's distance — contact points stay sharp and the shadow softens away from them.

### Flat layers in the 3D scene — `item.shadowPlate`

**Turning a flat layer in 3D — the pivot.** Every flat layer (image, video, shape, text, html clip) turns in 3D
with `rotateX` / `rotateY` / `rotateZ`, static fields and `propertyKeyframes` tracks alike: a static angle and the
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
  pixels are untouched.
- **`receiveShadow`** — the set's shadows fall across the layer. This is the only one
  that re-films the layer inside the lit scene, so **Motion Blur, Rig (Puppet) and 3D
  Depth are unavailable on that layer** while it is on; the other two leave them
  working.

**`lid`** matches `/^[A-Za-z0-9_-]{1,12}$/` and must be unique within the rig — it is the key keyframe tracks address.

**Sizes are multiples of composition height**, so a rig authored at 1080p is correct at 4K with no migration. `width: 4` on a 1080-tall comp is 4320 world px.

**A light is switched off with `intensity: 0`, never by removing it** — the light count is a compiled shader constant, so changing it recompiles every material in the scene. `on: false` is presentation only and does the same thing.

**Cyclorama shape `"none"`** draws nothing: use it for a rig that only carries lights. Any other shape with `material.mode: "solid"` writes depth, so layers behind it are cut by its surface.

**`material.mode: "shadowCatcher"`** keeps only the shadows the set receives and is transparent everywhere else, for models standing on the composition `background`. It writes no depth, so it never cuts a layer. Its shadows use `material.shadowColor` (default `#000000`), not `color` — `color` stays the Solid surface's colour, so a paper set switched to shadows does not paint them in the paper's own colour. `opacity` is the shadow strength (0-1), and the backdrop colour track `scc:cyc:col` drives `shadowColor` in this mode.

**Rig keyframes** live on the rig item's `propertyKeyframes` under two prefixes (`sc:` numeric, `scc:` colour — the prefix alone decides numeric vs RGBA interpolation):

In the editor, the stopwatch beside an animatable rig field promotes that exact
property into a flat 0%/100% track seeded from the field's current authored value.
Once any rig track exists, moving a selected light in the 3D world view auto-keys
its `az`, `elev` and `dist` tracks at the playhead instead of overwriting the base
rig. API-authored projects use the same track shape directly.

| Key | Range |
| --- | --- |
| `sc:<lid>:intensity` \| `az` \| `elev` \| `dist` | per the light's type |
| `sc:<lid>:angle` \| `penumbra` | spot only |
| `sc:<lid>:width` \| `height` | area only (world px) |
| `scc:<lid>:col` | colour |
| `sc:cyc:x` \| `y` \| `z` \| `rotX` \| `rotY` \| `rotZ` \| `scale` \| `opacity` | — |
| `scc:cyc:col` | colour |
| `sc:env:intensity` \| `exposure` \| `rotX` \| `rotY` \| `rotZ` | — |

**Refused, and the sanitizer drops them:** light `type`, adding/removing a light, `castShadow`, `shadowMapSize`, cyclorama `shape` and dimensions, `env.source`/`preset`/`url`. Each is a shader recompile or an environment re-bake, not a value — animating one would rebuild every frame. A track naming a `lid` that no longer exists is dropped on the next save.

**The playhead outside every rig clip does NOT mean darkness.** The nearest rig still lights the scene, and a project with no rig falls back to the legacy three directionals.

**21 built-in presets** (`rigPresets.js`), each a **complete** rig — applying one replaces `item.rig` wholesale:

| Category | Preset ids |
| --- | --- |
| Studio | `threePoint` (the exact legacy default — use it to match a pre-rig project), `studioRoom`, `clamshellBeauty`, `highKeyWhite` |
| Product | `productSoftbox`, `topDownProduct`, `turntable`, `pastelSweep`, `pianoBlack` |
| Dramatic | `rimLitDark`, `filmNoir`, `stageSpotlight`, `campfireGlow` |
| Daylight | `sunsetWindow`, `overcastExterior`, `desertNoon`, `blueHour` |
| Location | `warehouse`, `sciFiRoom` |
| Stylized | `neonTwoTone`, `duotonePop` |

**Other rig-item fields the editor writes.** `item.rigLook = { id, name, hash }` records which look was applied (a preset id, or `saved:<id>` for a look the user saved) and a hash of the rig at that moment, so the editor can mark the look as edited once the rig drifts from it. It is informational — omit it when emitting a rig; a hand-made `hash` never matches, so the look would show as edited from the start. `item.rigAi` holds the AI video state — the prerender used as the source, the takes and which one is placed on the timeline. It is written by the editor from real render and generation results; do not write it yourself.
