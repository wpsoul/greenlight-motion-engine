> **GreenLight Motion Engine:** this is the GreenLight Dash Video Editor's project format, which the engine reads as is.
> Ignore the `/api/...` routes and the app UI described here: in the engine you edit `project.json` and run
> `npx greenlight-motion build`. MotionFast templates (`mediaType: "motion"`) stay in GreenLight Dash.

# GreenLight Dash — Camera layers, paths, rigs and presets

> Read [video-projects.md](video-projects.md) for the shared project, clip, channel, timing and versioned-write contracts. Load only the sections needed for the task.

## Contents

- [Camera layers (`mediaType: "camera"`) — a virtual camera over the whole stack](video-camera.md#camera-layers-mediatype-camera--a-virtual-camera-over-the-whole-stack)
- [Camera presets (save & load reusable camera moves)](video-camera.md#camera-presets-save--load-reusable-camera-moves)
- [Camera Rig — a parametric camera move](video-camera.md#camera-rig--a-parametric-camera-move)

### Camera layers (`mediaType: "camera"`) — a virtual camera over the whole stack

A camera clip draws nothing. While the playhead is inside it, it poses a virtual camera that transforms **every other channel** — footage, text, shapes, sequences, mockups — as one. The project `background` is a screen-fit backdrop and deliberately does **not** move, so a zoom-out never reveals empty edges.

Rules:

- The camera lives on a channel marked `"kind": "camera"`. **A project may have at most one camera channel, and it must be LAST in the `channels` array** (channel order is z-order; last renders highest). The editor re-pins it on every write and on load, so a project authored with the camera elsewhere is silently reordered — emit it last to avoid surprising diffs. Put several camera clips on it to chain moves; the clip under the playhead wins, and outside every camera clip the camera is neutral.
- Camera clips are synthetic (no `url`) and are keyframed with their own property registry, using the ordinary `propertyKeyframes` shape (positions 0–100 % of the clip).
- Any channel can opt out with `"cameraLocked": true` — it renders exactly as if there were no camera (watermarks, fixed captions).
- A camera-locked layer is a 2D layer, as in After Effects: it composites in STACK order and never depth-tests against 3D. Above a model layer in the stack it draws over the model (a flash, a title at the comp plane needs no pulling toward the camera); at the very bottom of the stack (a full-frame backdrop) it stays behind everything, the Scene Rig's cyclorama included. 3D layers on either side of a locked layer still occlude each other by depth.

```json
{
  "clips": [
    { "id": "cam1", "source": "LOCAL", "mediaType": "camera", "url": "",
      "name": "Camera", "duration": 6 }
  ],
  "channels": [
    { "id": "ch-logo", "name": "Logo", "visible": true, "cameraLocked": true, "items": [ ... ] },
    { "id": "ch-cam", "name": "Camera", "kind": "camera", "visible": true, "unsnapped": true,
      "items": [
        { "id": "camitem1", "clipId": "cam1", "trimStart": 0, "trimEnd": 6, "freeStart": 2.0,
          "propertyKeyframes": {
            "camZoom": [
              { "position": 0,   "value": "1",    "easing": "AE Smooth" },
              { "position": 100, "value": "1.28", "easing": "AE Smooth" }
            ]
          } }
      ] }
  ]
}
```

Camera properties (the `CAMERA_KF_PROPS` registry in `frontend/src/components/videoEditor/projectCamera.js`):

| Property | Unit | Neutral | Meaning |
| --- | --- | --- | --- |
| `camZoom` | × | `1` | Lens zoom about the frame centre. Magnifies every layer equally — parallax unchanged. |
| `camX` | % of frame width | `0` | Positive pans the camera **right**, so content slides left. |
| `camY` | % of frame height | `0` | Positive pans the camera **down**, so content slides up. |
| `camRoll` | deg | `0` | Cants the horizon clockwise (dutch angle). |
| `camDolly` | px | `0` | Moves the viewpoint in/out. Unlike `camZoom` this DOES change perspective — layers at different `panZ`/`translateZ` separate. |
| `camTiltX` / `camTiltY` | deg | `0` | Pitch / yaw. |
| `camDofEnabled` | 0/1 | `0` | Depth-of-field master switch. |
| `camFocusDistance` | px | `0` | Distance to the sharp plane. `0` = the comp plane (`(H/2)/tan(14°)`), so it survives a canvas resize. |
| `camAperture` | px | `24` | Larger = shallower. `0` disables the blur entirely. |
| `camBlurLevel` | % | `100` | Scales the computed circle of confusion. `0` disables. |
| `camHighlightGain` | % | `0` | Bloom on bright pixels, so highlights form bokeh discs. |
| `camFocusX` / `camFocusY` | % | `50` | Focus point. Also the centre of the focus area when one is set. |
| `camFocusWidth` | % of frame width | `0` | `0` = the point is only a depth probe. Above `0` a screen-space region around the point stays sharp and eases to the layer's full blur by its edge. |
| `camPathT` | % | `0` | Progress along `cameraPath`; active only while that path has at least two points and `follow: true`. |
| `camPathOffsetX/Y/Z` | px | `0` | Constant displacement from `cameraPath`, on world axes (+X right, +Y **down**, +Z toward the viewer). The aim is computed **after** it, so a camera pushed off a shared path still faces its target. No-op unless the path is live. |

#### Camera Motion Paths (`cameraPath` + `camPathT`)

A camera item can ride a saved 3D bezier spline. It uses the same world-pixel point/handle convention as an object Motion Path: origin at comp centre, `x` right, `y` up, `z` toward the viewer; `hIn`/`hOut` are offsets from the anchor and `manual: true` marks them hand-shaped. The same rule applies — **write both handles and `manual: true` on every anchor**; an anchor with no handles is a corner the renderer flies straight through, since nothing auto-smooths a stored path outside the interactive world view. Use `hOut = (P[next] − P[prev]) / 6`, `hIn = −hOut` for a smooth anchor (ends of an open path: `(P[1] − P[0]) / 3` and `−(P[last] − P[last−1]) / 3`).

```json
{
  "cameraPath": {
    "points": [
      { "x": -700, "y": 120, "z": 1850 },
      { "x": 0, "y": 80, "z": 1450,
        "hIn": { "x": -220, "y": 0, "z": 120 },
        "hOut": { "x": 220, "y": 0, "z": -120 }, "manual": true },
      { "x": 620, "y": -100, "z": 1100 }
    ],
    "closed": false,
    "follow": true,
    "aim": "target",
    "targetId": "hero-item"
  },
  "camPathT": 0,
  "propertyKeyframes": {
    "camPathT": [
      { "position": 0, "value": "0", "easing": "Linear" },
      { "position": 100, "value": "100", "easing": "Linear" }
    ]
  }
}
```

- A camera path is live only with at least two points and `follow: true`. Provide a `camPathT` progress track (a linear 0→100 is the sensible default) unless the camera is intentionally parked on one point.
- `camPathT` is 0–100. Open paths run first→last; closed paths wrap 100 back to point one.
- `aim: "tangent"` looks along the curve. `aim: "target"` looks at `targetId`, or the composition centre when `targetId` is null/missing. `aim: "free"` leaves orientation to `camTiltX`, `camTiltY`, and `camRoll` base values/keyframes.
- Following owns the camera's position on the curve. Lens zoom and depth-of-field remain independent; free aim also keeps the manual orientation tracks authoritative.
- **Offset from path** — `camPathOffsetX/Y/Z` (table above). Two cameras, or a camera and a layer, can then ride one shared curve at a fixed distance apart. Keyframable like every other camera field.
- **Reusing another curve**: layer motion paths and camera paths share one world-pixel space, so `points`/`closed` transfer literally between them. See [Object Motion Paths](video-paths.md#object-motion-paths-motionpath--motionpatht) for converting a shape outline.
- `keyframesPerPoint` / `keyframesPerPointCount` / `keyframesPerPointClosed` are the same "one key per anchor" bookkeeping the object path uses: one evenly-spaced `camPathT` key per anchor (a closed path adding the final 100 key back to anchor one), so the camera reaches each point on a keyframe and the pacing between points can be shaped per segment. Omit it and author any valid progress track directly.
- The path lives on the camera **item**, so it trims, duplicates, saves, undoes, and renders with that camera clip.

Animating `camDolly` and `camZoom` in opposite directions is the vertigo effect.

**Depth of field** is physical and per layer: each layer's circle of confusion comes from its own distance to the camera (`aperture · |focusDistance − layerDistance| / layerDistance · blurLevel/100`), so a rack focus is just keyframed `camFocusDistance`. All the DOF fields above may be set either as a **base value on the camera item** (`item.camAperture = 40`) or as a keyframe track in `propertyKeyframes` — tracks win at the playhead. `camAperture: 0` or `camBlurLevel: 0` renders byte-identically to DOF off. There are no per-layer `dof*` fields — a project still carrying them animates nothing. Rendered by **`/render-onserver`** and the desktop render; the fast `/render` ignores camera layers along with everything else non-trivial.

**Screen-recording auto-zoom emits one of these** (a clip named `Auto-zoom` on the camera channel), so an agent asked to "make the zoom less aggressive" edits `camZoom` keys on that clip rather than hunting for an adjustment layer.

### Camera presets (save & load reusable camera moves)

Global JSON files under `media/camera-presets/` — a separate directory from `video-presets/`, so a camera preset and a sequence preset may share a name. Preset file format:

```json
{ "version": 1, "kind": "ve-camera-preset", "name": "Slow reveal", "duration": 4.0,
  "keyframes": [
    { "position": 0,   "easing": "AE Smooth", "properties": { "camZoom": "1.6", "camY": "-8" } },
    { "position": 100, "easing": "AE Smooth", "properties": { "camZoom": "1",   "camY": "0"  } }
  ],
  "base": { "camDofEnabled": 1, "camAperture": 40, "camFocusWidth": 35 } }
```

`base` is optional and holds the preset's **un-keyframed** camera settings — depth of
field is normally dialled in as static values rather than animated, so saving only
`keyframes` would lose the whole look. On apply, `base` is written onto the camera item
as base fields while `keyframes` become its `propertyKeyframes`; a property that is
keyframed never appears in `base` (its track already carries it). A preset may have
`base` and no `keyframes` — a pure lens/DOF setup with no motion.

Endpoints:

```
GET    /api/camera-presets              → { "presets": [{ "id", "name", "description", "duration", "keyframes", "base", "updated_at" }] }
POST   /api/camera-presets              { "name", "duration?", "keyframes", "base?" }   # needs keyframes OR base
DELETE /api/camera-presets/{preset_id}
```

Keyframe `position` is 0–100 % of the preset's own `duration`. To apply one: expand each snapshot into per-property tracks on a camera item (`{position, value, easing}` per property). Because positions are percentages, a preset spreads across whatever length the camera clip already has — applying one never needs to resize it.

**Applying a pose preset also sets `"cameraMoveMode": "free"`.** A Camera Rig, or a Motion Path with `follow: true`, overwrites the very props the preset animates (see the precedence note under Camera Rig), so a preset applied on top of one renders as nothing. Set the mode alongside the tracks whenever the preset touches `camX`, `camY`, `camDolly`, `camTiltX`, `camTiltY` or `camRoll`; leave the mode alone for a **Focus** preset (DOF only) or one that drives `camPathT`, which compose with a rig. `cameraRig` and `cameraPath` are never cleared — the mode flip is reversible.

24 built-in moves live in `CAMERA_MOTION_PRESETS` (`cameraMotionPresets.js`, common-snapshot shape, ids prefixed `cm-`), grouped **Cinematic** (`cm-quiet-push`, `cm-swoop-dive`, `cm-corkscrew`, `cm-fast-orbit`, `cm-lateral-glide`, `cm-parallax-arc`, `cm-arc-closeup`, `cm-grand-reveal`), **Editorial** (`cm-slingshot`, `cm-step-zoom`, `cm-handheld-breath`, `cm-soft-land`, `cm-documentary-follow`), **Energy** (`cm-weave-run`, `cm-s-curve-drift`, `cm-macro-sweep`, `cm-punch-through`), **Loops** (`cm-orbit-pulse`, `cm-float`, `cm-figure-eight` — first and last snapshots match, so they loop) and **Focus** (`cm-rack-to-near`, `cm-rack-to-far`, `cm-focus-chase`, `cm-macro-bloom` — DOF tracks only, no motion props, so they compose with the camera's static pose). Read the exact snapshots from that file. `CAMERA_PRESETS` in `projectCamera.js` seeds the keyframe-builder registry and is not a move catalog.

A preset key may carry a `bezier: [x1,y1,x2,y2]` alongside `easing: 'Custom'` — a per-segment curve. `commonToPropertyKeyframes` and `cameraItemToPreset` pass it through, so a hand-shaped camera move round-trips into a preset and back instead of degrading to Smooth. `cm-punch-through` (8.7 s, dolly only) is the built-in that uses one: a linear creep from dolly 98 to 235 over the first 71 %, then one custom segment that detonates to 2600. On a 1080-tall project `perspectiveDistance ≈ 2166`, so the last instant flies **through** the comp plane and the frame blows out — that is the move, not a bug; park layers on negative `panZ` to stop the camera short of them.

An entry may set `sparse: true`, which drops the usual "seed every motion prop" expansion so the preset writes tracks ONLY for the props it animates — it then composes with the pose the camera already holds instead of resetting it. `cm-punch-through` uses it (one `camDolly` track, nothing else); every other motion preset seeds the full pose.

### Camera Rig — a parametric camera move

A camera item's `cameraMoveMode` picks one of three exclusive modes: `"free"` (position/rotation keyframes, the default), `"path"` (the hand-drawn motion path), `"rig"` (`item.cameraRig`). **A rig writes no path**, so switching modes never destroys a drawn curve.

```jsonc
"cameraMoveMode": "rig",
"cameraRig": {
  "type": "orbit",            // orbit|dolly|crane|pushIn|truck|spiral|handheld|follow
  "aim": "center",            // center|path — where the camera looks
  "radius": 1800, "height": 400,
  "startAngle": -40, "sweep": 90,
  "rise": 0, "tilt": -8, "roll": 0,
  "distance": 1200, "turns": 1,
  "amplitude": 0, "frequency": 0, "seed": 7,  // handheld jitter, seeded
  "targets": []               // follow only — layer item ids, in hand-off order
}
```

Every type reads `radius`, `height`, `startAngle`, `tilt` and `roll`. On top of those: `orbit` adds `sweep`; `crane` adds `sweep` + `rise`; `spiral` adds `sweep` + `rise` + `turns`; `dolly`, `pushIn` and `truck` add `distance` (and read **no** `sweep`); `handheld` adds `amplitude` + `frequency`; `follow` adds `sweep` plus the `targets` list. The rest are stored and ignored.

**`follow` — a drone that rides an object.** The rig's orbit maths are re-based onto a followed layer's position: the camera keeps looking at it while `radius`/`height`/`startAngle`/`sweep` place and circle it, and a **moving** target drags the whole move with it. `targets` is an array of layer **item ids** (any positioned layer — not audio/voice); the keyframable camera track **`camFollowTarget`** (1-based, default `1`) names which entry the camera looks at. A key from `1` to `2` pans the look-at from one object to the next smoothly with the key's easing — **fractional values blend the two targets' positions**, so the hand-off is a camera move, not a cut. With an empty `targets` list (or dangling ids) the rig degrades to a plain orbit of the comp centre. `camFollowTarget`, like `camPathT`, is a driver track: the rig reads it and never overwrites it. A target's position is resolved through the same PRS machinery that places its mesh, so a layer riding an **object Motion Path** (`motionPath` + `motionPathT`) or moved by **keyframe parenting** is followed where it actually renders — not just its `panX/panY` + position tracks.

Parameter ranges (`CAMERA_RIG_PARAM_META` / `CAMERA_RIG_DEFAULTS`, `cameraRig.js`) — **values outside the range are clamped silently**, and the UI label differs from the JSON key for four of them:

| Key | UI label | Range | Default |
| --- | --- | --- | --- |
| `radius` | Radius | `100`–`20000` px | `1800` |
| `height` | Height | `−8000`–`8000` px | `400` |
| `startAngle` | **Start** | `−360`–`360`° | `−40` |
| `sweep` | Sweep | `−720`–`720`° | `90` |
| `rise` | Rise | `−8000`–`8000` px | `0` |
| `distance` | **Travel** | `−20000`–`20000` px | `1200` |
| `turns` | Turns | `0.25`–`8` × | `1` |
| `tilt` | Tilt | `−80`–`80`° | `−8` |
| `roll` | Roll | `−180`–`180`° | `0` |
| `amplitude` | **Amount** | `0`–`2000` px | `0` |
| `frequency` | **Rate** | `0`–`40` × | `0` |

`seed` (default `7`) has no UI field and no range — it only re-rolls the `handheld` jitter. `targets` (default `[]`, max 50 ids) is the `follow` type's hand-off list; junk entries are dropped by the sanitizer.

**Twelve built-in rigs** (`CAMERA_RIG_PRESETS`, `cameraRig.js`) — each is a **complete** `cameraRig`, applied wholesale (a partial one leaves the previous shot's radius behind): `heroOrbit`, `slowReveal`, `turntable` (orbit), `craneDown`, `riseReveal` (crane), `pushIn` (pushIn), `pullBack` (dolly), `truckLeft` (truck), `productSpiral` (spiral), `handheldDrift` (handheld), `droneFollow`, `chaseCam` (follow). Read the exact numbers from that file rather than guessing them. Follow presets carry **no `targets`** — which layers to ride is project wiring, and the panel preserves the current list when any preset is applied; emitting a preset over an existing rig should do the same.

**Mode precedence — a rig or a live path BEATS the pose keyframes.** `getCameraPose` reads the tracks first, then `applyCameraRig` (mode `"rig"`) or `applyCameraPath` (mode `"path"` with a live path) overwrites `camX`, `camY`, `camDolly` — plus `camTiltX`/`camTiltY`/`camRoll` whenever an aim is computed. So on a rigged camera, `camX`/`camY`/`camDolly`/tilt/roll keyframes are stored, drawn in the timeline, and **render as nothing**. `camZoom`, the whole DOF family, `camPathT` and `camFollowTarget` are untouched by both and compose freely. Emitting a pose move therefore means emitting `"cameraMoveMode": "free"` (or omitting the field) with it — the editor enforces the same rule by flipping the mode to `"free"` when a motion preset that animates those props is applied, keeping `cameraRig` and `cameraPath` on the item so switching back restores the move.

**Rig parameters are NOT keyframable** — keying `radius` would rebuild the whole move every frame. **`camPathT` (Path Progress) is the track that carries the move**, and a rig with no `camPathT` keys sits frozen at its start pose. Always emit `camPathT` 0 → 100 alongside a `cameraRig`:

```jsonc
"propertyKeyframes": { "camPathT": [
  { "position": 0, "value": 0, "easing": "Linear" },
  { "position": 100, "value": 100, "easing": "Linear" }
] }
```

Keys use the same shape as every other track: `position` is 0–100 % of the camera clip, and `easing` is a named easing value. Progress tracks (`camPathT`, a layer's `motionPathT`) take `"Linear"` — constant speed along the move, which is what the editor itself writes; an eased progress (`"Smooth"`, `"AE Smooth"`) makes the camera crawl at both ends, so use one only when that slow start and landing is the intent. A key without a numeric `position` is dropped when the project loads, which leaves the rig frozen exactly as if no track had been sent.

**`aim` picks what the camera faces.** `"center"` (the default, also when the key is absent) aims at the point the rig is built around — the comp centre, or the followed layer for `follow`. `"path"` faces the direction of travel (orient along path). It suits moves that travel toward or past the subject (`pushIn`, `dolly`, `crane`, `truck`); on an `orbit` or `spiral` it looks along the circle, roughly 90° away from the subject. A rig that does not move (zero `sweep`/`distance`, a `handheld` with `amplitude` 0) keeps the centre aim. `aim` is a choice about the shot's framing, not part of a preset: keep the current value when emitting a preset over an existing rig, as with `targets`.

**`tilt` moves the AIM POINT, not the camera's own rotation**, so the subject stays framed as the rig travels. With `"aim": "path"` the same lift tips the gaze above or below the direction of travel. `handheld` jitter is a pure function of `seed` and progress — never wall-clock — so preview and export match frame for frame.

**Rendering.** Model layers render in the editor preview, the desktop Download, **`/render-onserver`** / **`/render-onserver-job`**, and **`/render-still`**. The fast `/render` does **not** support them (video/image only). Very heavy assets (≳900 k triangles) render slowly enough that an export can look hung — prefer decimated models.
