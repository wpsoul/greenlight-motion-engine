> **GreenLight Motion Engine:** this is the GreenLight Dash Video Editor's project format, which the engine reads as is.
> Ignore the `/api/...` routes and the app UI described here: in the engine you edit `project.json` (or `apply`) and run
> `npx greenlight-motion build`; what `GET /api/video-editor/capabilities` returns there is `npx greenlight-motion schema <topic>`
> here. `frontend/src/…` paths are files of the engine's public source repository. MotionFast templates (`mediaType: "motion"`)
> stay in GreenLight Dash.

# GreenLight Dash — Camera layers, depth of field, paths, rigs and presets

> Read [video-projects.md](video-projects.md) for the shared project, clip, channel, timing and versioned-write contracts. Load only the sections needed for the task.

## Contents

- [Camera layers (`mediaType: "camera"`) — a virtual camera over the whole stack](#camera-layers-mediatype-camera--a-virtual-camera-over-the-whole-stack)
  - [Camera properties](#camera-properties)
  - [Camera Motion Paths (`cameraPath` + `camPathT`)](#camera-motion-paths-camerapath--campatht)
  - [Depth of field](#depth-of-field) — per layer for flat layers, per pixel for model layers, the cyclorama and occluding plates
  - [Screen recordings' camera](#screen-recordings-camera)
- [A sequence's own camera](#a-sequences-own-camera)
- [Smart Zoom — the camera's Zoom mode](#smart-zoom--the-cameras-zoom-mode)
- [Drawn cursor](#drawn-cursor--a-screen-recording-with-no-cursor-in-its-picture)
- [Camera presets (save & load reusable camera moves)](#camera-presets-save--load-reusable-camera-moves)
  - [Built-in camera moves](#built-in-camera-moves)
- [Camera Rig — a parametric camera move](#camera-rig--a-parametric-camera-move)
  - [Rig parameters](#rig-parameters)
  - [Built-in rigs](#built-in-rigs)
  - [Mode precedence](#mode-precedence)

### Camera layers (`mediaType: "camera"`) — a virtual camera over the whole stack

A camera clip draws nothing. While the playhead is inside it, it poses a virtual camera that transforms **every other channel** — footage, text, shapes, sequences, mockups — as one. The project `background` is a screen-fit backdrop and deliberately does **not** move, so a zoom-out never reveals empty edges.

Rules:

- The camera lives on a channel marked `"kind": "camera"`. **A timeline may have at most one camera channel, and it must be LAST in its `channels` array** (the project's, and each sequence's for its own camera — see [A sequence's own camera](#a-sequences-own-camera)); channel order is z-order, so last renders highest. The editor re-pins it on every write and on load, so a project authored with the camera elsewhere is silently reordered — emit it last to avoid surprising diffs. Put several camera clips on it to chain moves; the clip under the playhead wins, and outside every camera clip the camera is neutral.
- Camera clips are synthetic (no `url`) and are keyframed with their own property registry (below), using the ordinary `propertyKeyframes` shape: `position` 0–100 % of the clip, `value` a string.
- Any channel can opt out with `"cameraLocked": true` — it renders exactly as if there were no camera (watermarks, fixed captions).
- In a 3D Scene the Camera layer films the world too, depth of field included, unless the Scene names its own `rig.scene.camera` (world3d.md (GreenLight Dash only)).
- A camera-locked layer is a 2D layer, as in After Effects: it composites in STACK order and never depth-tests against 3D. Above a model layer in the stack it draws over the model (a flash, a title at the comp plane needs no pulling toward the camera); at the very bottom of the stack (a full-frame backdrop) it stays behind everything, the Scene Rig's cyclorama included. 3D layers on either side of a locked layer still occlude each other by depth.

```jsonc
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

#### Camera properties

Every field below can be a **base value on the camera item** (`item.camAperture = 40`) or a keyframe track in `propertyKeyframes`; a track wins at the playhead.

| Property | Unit | Neutral | Meaning |
| --- | --- | --- | --- |
| `camZoom` | × | `1` | Lens zoom about the frame centre. Magnifies every layer equally — parallax unchanged. |
| `camX` | % of frame width | `0` | Positive pans the camera **right**, so content slides left. |
| `camY` | % of frame height | `0` | Positive pans the camera **down**, so content slides up. |
| `camRoll` | deg | `0` | Cants the horizon clockwise (dutch angle). |
| `camDolly` | px | `0` | Moves the viewpoint in (positive) or out. Unlike `camZoom` this DOES change perspective — layers at different `panZ`/`translateZ` separate. |
| `camTiltX` / `camTiltY` | deg | `0` | Pitch / yaw, any angle. Past ±90° the camera orbits behind the comp plane and sees the layers from the back, mirrored. |
| `camDofEnabled` | 0/1 | `0` | Depth-of-field master switch. |
| `camFocusDistance` | px | `0` | Distance to the sharp plane. `0` = the comp plane (`(H/2)/tan(14°)`), so it survives a canvas resize. |
| `camAperture` | px | `24` | The blur's radius in px (not its width) for something far behind the focus plane, at `camBlurLevel` 100. Larger = shallower. `0` disables the blur entirely. |
| `camBlurLevel` | % | `100` | Scales the computed circle of confusion. `0` disables. |
| `camHighlightGain` | % | `0` | Bloom on bright pixels, so highlights form bokeh discs. |
| `camFocusX` / `camFocusY` | % | `50` | Focus point. Also the centre of the focus area when one is set. |
| `camFocusWidth` | % of frame width | `0` | `0` = the point is only a depth probe. Above `0` a screen-space region around the point stays sharp and eases to the layer's full blur by its edge. |
| `camPathT` | % | `0` | Progress along `cameraPath` or a Camera Rig's move (0–100). |
| `camPathOffsetX/Y/Z` | px | `0` | Constant displacement from `cameraPath`, on world axes (+X right, +Y **down**, +Z toward the viewer). The aim is computed **after** it, so a camera pushed off a shared path still faces its target. No-op unless the path is live. |
| `camFollowTarget` | 1-based index | `1` | Which `cameraRig.targets` entry a `follow` rig looks at (see [Camera Rig](#camera-rig--a-parametric-camera-move)). |

Animating `camDolly` and `camZoom` in opposite directions is the vertigo effect.

#### Camera Motion Paths (`cameraPath` + `camPathT`)

A camera item can ride a saved 3D bezier spline. It uses the same world-pixel point/handle convention as an [object Motion Path](video-paths.md#object-motion-paths-motionpath--motionpatht): origin at comp centre, `x` right, `y` up, `z` toward the viewer; `hIn`/`hOut` are offsets from the anchor. **Write both handles and `manual: true` on every anchor** — an anchor with no handles is a corner the renderer flies straight through, since nothing auto-smooths a stored path but a hand edit in the editor. Compute them with the [tangent rule](video-shapes.md#writing-the-handles) (each handle also carries `z`).

```json
{
  "cameraMoveMode": "path",
  "cameraPath": {
    "points": [
      { "x": -700, "y": 120, "z": 1850,
        "hIn": { "x": -233.3, "y": 13.3, "z": 133.3 },
        "hOut": { "x": 233.3, "y": -13.3, "z": -133.3 }, "manual": true },
      { "x": 0, "y": 80, "z": 1450,
        "hIn": { "x": -220, "y": 0, "z": 120 },
        "hOut": { "x": 220, "y": 0, "z": -120 }, "manual": true },
      { "x": 620, "y": -100, "z": 1100,
        "hIn": { "x": -206.7, "y": 60, "z": 116.7 },
        "hOut": { "x": 206.7, "y": -60, "z": -116.7 }, "manual": true }
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

- **A path drives the camera only while `cameraMoveMode` is `"path"` or absent**, and the path is live: at least two points and `follow: true`, or one point on `aim: "captured"`, which holds the camera there. An explicit `"free"`, `"rig"` or `"smartZoom"` ignores the path. Applying a camera preset that animates the pose writes `"free"`, so set `"cameraMoveMode": "path"` whenever you add a path to an existing camera.
- Provide a `camPathT` progress track (a `Linear` 0→100 is the sensible default) unless the camera is intentionally parked on one point. `camPathT` is 0–100; open paths run first→last, closed paths wrap 100 back to point one.
- `aim: "tangent"` looks along the curve. `aim: "target"` looks at `targetId` (a timeline item id), or the composition centre when `targetId` is null/missing. `aim: "free"` leaves orientation to `camTiltX`, `camTiltY`, and `camRoll` base values/keyframes. `aim: "captured"` reads it from each point: `rx`, `ry`, `rz` are Tilt X, Tilt Y and Roll in degrees, interpolated between points, and the `camTilt`/`camRoll` tracks are ignored.
- **Timing a path by points** — segments are walked at a uniform rate, so point `i` of `n` is reached where `camPathT` equals `i / (n - 1) * 100` (`i / n * 100` when closed). To land on a point at a chosen moment, key that value at that clip position, with `"easing": "Linear"`.
- Following owns the camera's position on the curve. Lens zoom and depth of field remain independent; free aim also keeps the manual orientation tracks authoritative.
- **Offset from path** — `camPathOffsetX/Y/Z` (table above). Two cameras, or a camera and a layer, can then ride one shared curve at a fixed distance apart. Keyframable like every other camera field.
- **Reusing another curve**: layer motion paths and camera paths share one world-pixel space, so `points`/`closed` transfer literally between them.
- `keyframesPerPoint` / `keyframesPerPointCount` / `keyframesPerPointClosed` are the same "one key per anchor" bookkeeping the object path uses: one evenly-spaced `camPathT` key per anchor (a closed path adding the final 100 key back to anchor one), so the camera reaches each point on a keyframe and the pacing between points can be shaped per segment. Omit it and author any valid progress track directly.
- The path lives on the camera **item**, so it trims, duplicates, saves, undoes, and renders with that camera clip.

#### Depth of field

Depth of field is physical and needs `camDofEnabled: 1`. Each layer's circle of confusion comes from its distance `d` to the camera, as a blur radius in px: `CoC = camAperture · |camFocusDistance − d| / d · camBlurLevel/100`, capped at 64 px. A rack focus is therefore just a keyframed `camFocusDistance`.

- **Flat layers** (text, shapes, pictures, video) take one CoC per layer: the depth of their plane.
- **Model layers, the Scene Rig's cyclorama and occluding shadow plates blur per pixel.** They hand the compositor their depth buffer, and every pixel blurs by the CoC of its own distance (capped at 64 px, still held sharp inside the focus area). A character in focus stays sharp in the same model as a wall metres behind it, so a whole set, backdrop included, can live in one model layer.
- **The gather is depth-aware:** a blurred background never smears over a sharp foreground edge, a sharp foreground leaves no halo on the blurred background, and a foreground in front of the focus plane blurs out over what is behind it and past its own silhouette. Taps read the picture prefiltered, so thin bright detail under a wide blur (lettering far behind the focus) averages instead of sparkling; flat layers get the same.
- **Both distances are view depth from the camera**, so a camera that moves carries the sharp plane with it. Under a dolly the subject at depth `z` (its `panZ`) sits at `perspectiveDistance − camDolly − z` (`perspectiveDistance = (H/2)/tan(14°)`, ≈ 2166 on a 1080-tall frame). To keep a subject sharp through a move, key `camFocusDistance` on the dolly's own keys with that value; under a rig, key it with the subject's depth along the rig's view at a few points of the move (a GreenLight Motion scene script's `dof.focus` does both).
- **In a 3D Scene** the same numbers set Final's thin lens, so Final blurs as Draft does (see world3d.md (GreenLight Dash only)).
- **Matching a real lens.** For a lens of focal length `f` mm at f-number `N` on a sensor `S` mm wide, with the focus `F` in px (a composition pixel is a millimetre of a 3D Scene) and the frame `W` px wide: `camAperture = f² · W / (2 · N · (F − f) · S)`, at `camBlurLevel` 100. Past the field's 300, raise `camBlurLevel` instead (a `.blend` import keys it this way).
- **Focus area:** `camFocusWidth` above 0 keeps a screen region around `camFocusX`/`camFocusY` sharp whatever its depth, easing to the full blur by its edge.
- `camAperture: 0` or `camBlurLevel: 0` renders byte-identically to DOF off. There are no per-layer `dof*` fields — `dof*` fields on a layer animate nothing. The Focus presets in [Built-in camera moves](#built-in-camera-moves) are ready rack-focus moves.
- Rendered by **`/render-onserver`** and the desktop render; the fast `/render` ignores camera layers along with everything else non-trivial.

#### Screen recordings' camera

A screen recording gets a **Smart Zoom** camera, a clip named `Smart Zoom` (see [Smart Zoom](#smart-zoom--the-cameras-zoom-mode)). A recording's camera can instead be a clip named `Auto-zoom` with baked `camZoom`/`camX`/`camY` keys. So for "make the zoom less aggressive", change the Smart Zoom preset, or edit `camZoom` keys on an `Auto-zoom` clip. Never hunt for an adjustment layer.

### A sequence's own camera

A sequence (`mediaType: "sequence"`) can carry its own camera: a camera clip on a `"kind": "camera"` channel, LAST in
`sequence.channels`, timed in the sequence's own seconds. It films that sequence's layers exactly as the project camera
films the top level — its move, its rig, Smart Zoom, depth of field per layer, and `cameraLocked` channels inside the
sequence stay put. The project camera, if any, then films the sequence as a whole. Each scene of a film can so have its
own camera while a cross transition still blends the whole scenes. A GreenLight Motion scene script's real camera
(a scene's `camera` with `move`, `rig`, `zooms`, `keyframes` or `dof`) is built this way, with the scene's backdrop
channel camera-locked so a zoom or an orbit never shows its edge.

### Smart Zoom — the camera's Zoom mode

Smart Zoom (`"cameraMoveMode": "smartZoom"`) zooms the camera in over **zoom ranges** on the camera layer. They are
automatic from a screen recording's clicks, or placed by hand. Nothing is baked into keyframes:

```jsonc
"cameraMoveMode": "smartZoom",
"smartZoom": {
  "clipId": "<the recording's CLIP id>",  // null: no recording, the ranges are placed by hand
  "preset": "studio",                     // studio|calm|precise|lively|follow
  "ranges": [                             // optional. Absent = automatic, from the recording's clicks
    { "id": "r1", "startMs": 2700, "endMs": 5580, "mode": "follow" },
    { "id": "z2", "startMs": 9000, "endMs": 11400, "mode": "fixed", "point": { "x": 0.3, "y": 0.7 }, "zoom": 2 }
  ]
}
```

- **Ranges:**
  - `startMs`/`endMs` are in the **recording's own time** (source ms, so trims and moves keep a zoom on its moment).
    With no recording they are the camera clip's own time. A range shorter than 100 ms is dropped.
  - `zoom` is 1–4; absent = the preset's (Studio 1.45).
  - `mode: "follow"` aims at the clicks inside the range. `mode: "fixed"` centres the view exactly on `point` (0..1 of
    the frame).
  - `disabled: true` keeps a range but skips it.
  - Writing `ranges` replaces the automatic list. Copy the automatic ones first (ids `r1`, `r2`…) to keep them.
    Removing `ranges` goes back to the automatic zooms.

- **How it decides:**
  - It reads the recording clip's `recordingMeta` (its clicks and cursor track).
  - It zooms in from 0.3 s before a click until 2.5 s after the last one, and moves part of the way toward each group of clicks.
  - Every move is a spring, so the camera never stops and restarts between clicks.
- **It follows the recording's items on the timeline.** Trims, splits, moves and speed changes re-aim it on their own. Outside the recording's items, the camera rests at zoom 1, centred. It only acts inside its own camera clip's span.
- **Presets** (an unknown id reads as `studio`):

  | Preset | Look |
  |---|---|
  | `studio` | Default, like Screen Studio: 1.45×, aims part-way |
  | `calm` | 1.35×, slow; the clicked spot stays put |
  | `precise` | 1.6×, clicks near the middle |
  | `lively` | 1.7×, quick |
  | `follow` | 1.5×, follows the cursor, not only clicks |

  The recorder sets one before the take; a take recorded with no zoom gets no camera at all.
- **Precedence:** it drives `camZoom`, `camX` and `camY`, so keys on those three render as nothing. `camRoll`, `camDolly`, tilt and depth of field compose as usual. A motion preset that animates zoom or pan flips the mode to `"free"`.
- **Changing it:**
  - Patch `smartZoom.preset` on the live project to change the look, or `smartZoom.ranges` to place zooms.
  - Set `"cameraMoveMode": "free"` to drive the camera by hand. `smartZoom` stays on the item, so setting the mode
    back to `"smartZoom"` restores it.
  - A recording clip without `recordingMeta` (no Input Monitoring) has no automatic zooms, but ranges you add still
    work.

### Drawn cursor — a screen recording with no cursor in its picture

The macOS recorder (Full screen / Area) and the agent template (`CURSOR=drawn`, its default) record the screen
**without** the cursor. The editor draws a smooth one back onto the recording's own picture, so effects, masks,
mockups, transitions and the camera treat it like a recorded cursor. Three fields make it:

```jsonc
// the recording CLIP
"recordingMeta": { /* clicks + a light path */ "cursorInVideo": false },
"recordingTrackUrl": "/media/<board folder>/screen_….glcursor",   // the hand's full path + cursor shapes, beside the video
// its timeline ITEM (absent = drawn with the Studio look)
"recordingCursor": { "enabled": true, "preset": "studio" }
```

- **`recordingCursor`** fields; any set field overrides the preset's:
  - `enabled`: false hides the cursor.
  - `preset`: `studio`, `calm`, `precise`, `lively` or `follow`. The same ids as Smart Zoom; each sets a cursor look.
  - `size`: 0.25–6, a multiple of the real cursor. Studio is 1.5.
  - `smoothing`: `off`, `spring`, `zerolag` or `spline`.
  - `clickEffect`: `press`, `ring` or `none`.
  - `hideIdleMs`: fade after this long still; 0 = never.
  - `tilt`: 0–40.
  - `motionBlur`: 0–2; 0 = none.
- **Only for `recordingMeta.cursorInVideo === false`.** A recording that has the cursor in its picture (Windows,
  Linux, Window capture) ignores `recordingCursor`; the cursor it has can't be removed.
- The cursor lands exactly on each click, presses on mouseDown and takes the real shape (hand over links, I-beam
  over text) from the track. A missing or failed `.glcursor` falls back to the light path in `recordingMeta`.
- To change it, edit the live project: GET, set the item's `recordingCursor`, PUT with `expected_version`.

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

`base` is optional and holds the preset's **un-keyframed** camera settings — depth of field is normally dialled in as static values rather than animated, so saving only `keyframes` would lose the whole look. On apply, `base` is written onto the camera item as base fields while `keyframes` become its `propertyKeyframes`; a property that is keyframed never appears in `base` (its track already carries it). A preset may have `base` and an empty `keyframes` list — a pure lens/DOF setup with no motion.

Endpoints:

```
GET    /api/camera-presets              → { "presets": [{ "id", "name", "description", "duration", "keyframes", "base", "updated_at" }] }
POST   /api/camera-presets              { "name", "duration?", "keyframes", "base?" }   # keyframes is required: send [] for a base-only preset
DELETE /api/camera-presets/{preset_id}
```

Keyframe `position` is 0–100 % of the preset's own `duration`. To apply one: expand each snapshot into per-property tracks on a camera item (`{position, value, easing}` per property, plus `bezier` when the easing is `Custom`). Because positions are percentages, a preset spreads across whatever length the camera clip already has — applying one never needs to resize it.

**Applying a pose preset also sets `"cameraMoveMode": "free"`.** A Camera Rig, or a live Motion Path, overwrites the very props the preset animates (see [Mode precedence](#mode-precedence)), so a preset applied on top of one renders as nothing. Set the mode alongside the tracks whenever the preset touches `camX`, `camY`, `camDolly`, `camTiltX`, `camTiltY` or `camRoll`; leave the mode alone for a preset that only animates depth of field or `camPathT`, which compose with a rig. `cameraRig` and `cameraPath` stay on the item, so the mode flip is reversible.

A preset key may carry a `bezier: [x1,y1,x2,y2]` alongside `easing: "Custom"` — a per-segment curve. Saving a camera as a preset and applying it both keep the curve, so a hand-shaped camera move round-trips instead of degrading to `Smooth`.

#### Built-in camera moves

The editor's 24 built-in moves, as compact snapshots. Each line is `id`, category, duration in seconds and its keys as `[position, easing of the segment after the key, values set at this key]` (plus `{"bezier": […]}` before the values on a `Custom` key). To turn one into tracks:

1. **Values carry forward:** each key holds every value set at it or at an earlier key.
2. **The first key resets the pose:** unless the move is `sparse`, a move that animates any of `camZoom`, `camX`, `camY`, `camRoll`, `camDolly`, `camTiltX`, `camTiltY` first sets all seven to neutral (`camZoom` 1, the rest 0), so it starts from a clean pose. A depth-of-field field it uses starts from its neutral in the [Camera properties](#camera-properties) table.
3. **A key whose easing is `null` uses `Smooth`** (on the last key it plays no segment).
4. Write every value as a string, one track per property with a key at every position, and set `"cameraMoveMode": "free"` when the move touches the pose (above).

```jsonc
{"id": "cm-quiet-push", "cat": "Cinematic", "dur": 6, "k": [[0, "AE Smooth", {"camZoom": 1.02, "camY": 1}], [100, null, {"camZoom": 1.16, "camDolly": 80, "camY": 0}]]}
{"id": "cm-swoop-dive", "cat": "Cinematic", "dur": 4.5, "k": [[0, "Expo Out", {"camY": 9, "camTiltX": -14, "camZoom": 1.35, "camDolly": -120, "camRoll": -3}], [100, null, {"camY": -3, "camTiltX": 3, "camZoom": 1.1, "camDolly": 160, "camRoll": 0}]]}
{"id": "cm-corkscrew", "cat": "Cinematic", "dur": 5, "k": [[0, "AE Smooth", {"camRoll": -22, "camTiltY": -10, "camZoom": 1.6, "camX": -5, "camY": -3}], [100, null, {"camRoll": 0, "camTiltY": 4, "camZoom": 1.08, "camX": 1, "camY": 0}]]}
{"id": "cm-fast-orbit", "cat": "Cinematic", "dur": 3, "k": [[0, "Linear", {"camTiltY": -20, "camX": -8, "camZoom": 1.12}], [100, null, {"camTiltY": 20, "camX": 8, "camZoom": 1.12}]]}
{"id": "cm-lateral-glide", "cat": "Cinematic", "dur": 6, "k": [[0, "Smooth", {"camX": -7, "camY": 0.8, "camTiltY": -1.8, "camZoom": 1.08}], [50, "Smooth", {"camX": 0, "camY": 0, "camTiltY": 0, "camZoom": 1.1}], [100, null, {"camX": 7, "camY": -0.8, "camTiltY": 1.8, "camZoom": 1.12}]]}
{"id": "cm-parallax-arc", "cat": "Cinematic", "dur": 7, "k": [[0, "Smooth", {"camX": -8, "camTiltY": -4.5, "camDolly": -80, "camZoom": 1.08}], [50, "Smooth", {"camX": 0, "camTiltY": 0, "camDolly": 170, "camZoom": 1.13}], [100, null, {"camX": 8, "camTiltY": 4.5, "camDolly": -80, "camZoom": 1.08}]]}
{"id": "cm-arc-closeup", "cat": "Cinematic", "dur": 6, "k": [[0, "Cubic Out", {"camX": -11, "camY": 2, "camTiltY": -9, "camDolly": -140, "camZoom": 0.96}], [30, "Smooth", {"camX": -4, "camY": 1, "camTiltY": -4, "camDolly": 40, "camZoom": 1.06}], [65, "Smooth", {"camX": 5, "camY": -1, "camTiltY": 2, "camDolly": 230, "camZoom": 1.26}], [100, null, {"camX": 1.5, "camY": 0, "camTiltY": 3, "camDolly": 160, "camZoom": 1.16}]]}
{"id": "cm-grand-reveal", "cat": "Cinematic", "dur": 3.5, "k": [[0, "Linear", {"camZoom": 2.3, "camRoll": -5, "camY": -4, "camDolly": 220}], [55, "Smooth", {}], [100, null, {"camZoom": 1, "camRoll": 0, "camY": 0, "camDolly": 0}]]}
{"id": "cm-slingshot", "cat": "Editorial", "dur": 1.8, "k": [[0, "Impulse", {"camZoom": 1.05}], [100, null, {"camZoom": 1.75, "camDolly": 260, "camY": -1}]]}
{"id": "cm-step-zoom", "cat": "Editorial", "dur": 2.4, "k": [[0, "Hold", {}], [25, "Hold", {"camZoom": 1.16, "camX": 2}], [50, "Hold", {"camZoom": 1.32, "camX": -1.5}], [75, "Hold", {"camZoom": 1.5, "camX": 0}], [100, null, {}]]}
{"id": "cm-handheld-breath", "cat": "Editorial", "dur": 8, "k": [[0, "Sine Smooth", {"camX": -0.4, "camY": 0.4, "camRoll": -0.15, "camZoom": 1.05}], [19, "Sine Smooth", {"camX": 1.1, "camY": -0.6, "camRoll": 0.3, "camZoom": 1.062}], [43, "Sine Smooth", {"camX": -0.8, "camY": 0.9, "camRoll": -0.25, "camZoom": 1.054}], [68, "Sine Smooth", {"camX": 0.6, "camY": 0.2, "camRoll": 0.2, "camZoom": 1.068}], [87, "Sine Smooth", {"camX": -0.9, "camY": -0.5, "camRoll": -0.22, "camZoom": 1.058}], [100, null, {"camX": -0.4, "camY": 0.4, "camRoll": -0.15, "camZoom": 1.05}]]}
{"id": "cm-soft-land", "cat": "Editorial", "dur": 4.2, "k": [[0, "Expo Out", {"camY": 9, "camTiltX": -8, "camDolly": -130, "camZoom": 0.94, "camRoll": -2}], [60, "Smooth", {"camY": -0.6, "camTiltX": 1.2, "camDolly": 30, "camZoom": 1.04, "camRoll": 0.4}], [100, null, {"camY": 0, "camTiltX": 0.6, "camDolly": 0, "camZoom": 1.01, "camRoll": 0}]]}
{"id": "cm-documentary-follow", "cat": "Editorial", "dur": 5, "k": [[0, "Smooth", {"camX": -3, "camY": 1.5, "camRoll": -0.15, "camZoom": 1.06}], [38, "Smooth", {"camX": 1, "camY": -0.5, "camRoll": 0.25, "camZoom": 1.1}], [72, "Smooth", {"camX": -0.5, "camY": 0.8, "camRoll": -0.1, "camZoom": 1.08}], [100, null, {"camX": 2.5, "camY": 0, "camRoll": 0.1, "camZoom": 1.12}]]}
{"id": "cm-weave-run", "cat": "Energy", "dur": 5.5, "k": [[0, "Sine Smooth", {"camX": -8, "camRoll": -3, "camDolly": -150, "camZoom": 1.1, "camTiltY": -4}], [30, "Sine Smooth", {"camX": 6, "camRoll": 3, "camDolly": 0, "camTiltY": 3}], [60, "Sine Smooth", {"camX": -5, "camRoll": -2.5, "camDolly": 140, "camTiltY": -3}], [100, null, {"camX": 7, "camRoll": 2, "camDolly": 300, "camTiltY": 4}]]}
{"id": "cm-s-curve-drift", "cat": "Energy", "dur": 6.5, "k": [[0, "Smooth", {"camX": -10, "camY": 3, "camTiltY": -6, "camDolly": -90, "camZoom": 1.05, "camRoll": -1}], [33, "Smooth", {"camX": 4, "camY": -1.5, "camTiltY": 1, "camDolly": 60, "camZoom": 1.12, "camRoll": 0.5}], [66, "Smooth", {"camX": -3, "camY": 1, "camTiltY": -2, "camDolly": 160, "camZoom": 1.18, "camRoll": -0.5}], [100, null, {"camX": 10, "camY": -2, "camTiltY": 5, "camDolly": 90, "camZoom": 1.1, "camRoll": 1}]]}
{"id": "cm-macro-sweep", "cat": "Energy", "dur": 5, "k": [[0, "Smooth", {"camZoom": 1.5, "camX": -8, "camTiltY": -5, "camY": 1}], [50, "Smooth", {"camZoom": 1.62, "camX": 2, "camTiltY": 1, "camY": -0.5}], [100, null, {"camZoom": 1.46, "camX": 9, "camTiltY": 5, "camY": 1}]]}
{"id": "cm-punch-through", "cat": "Energy", "dur": 8.7, "sparse": true, "k": [[0, "Linear", {"camDolly": 98}], [71, "Custom", {"bezier": [0.8187, 0.1079, 0.9089, 0.302]}, {"camDolly": 234.7692}], [100, "AE In (arrive)", {"camDolly": 2600}]]}
{"id": "cm-orbit-pulse", "cat": "Loops", "dur": 7, "k": [[0, "Sine Smooth", {"camTiltY": -13, "camX": -5, "camY": 1, "camZoom": 1.06}], [50, "Sine Smooth", {"camTiltY": 13, "camX": 5, "camY": -1, "camZoom": 1.2}], [100, null, {"camTiltY": -13, "camX": -5, "camY": 1, "camZoom": 1.06}]]}
{"id": "cm-float", "cat": "Loops", "dur": 5.5, "k": [[0, "Sine Smooth", {"camY": 2.2, "camRoll": -1.6, "camZoom": 1.1}], [50, "Sine Smooth", {"camY": -2.2, "camRoll": 1.6, "camZoom": 1.17}], [100, null, {"camY": 2.2, "camRoll": -1.6, "camZoom": 1.1}]]}
{"id": "cm-figure-eight", "cat": "Loops", "dur": 6, "k": [[0, "Sine Smooth", {"camX": -11, "camY": 0, "camRoll": 0, "camZoom": 1.15}], [25, "Sine Smooth", {"camX": 0, "camY": 7, "camRoll": 2.5}], [50, "Sine Smooth", {"camX": 11, "camY": 0, "camRoll": 0}], [75, "Sine Smooth", {"camX": 0, "camY": -7, "camRoll": -2.5}], [100, null, {"camX": -11, "camY": 0, "camRoll": 0}]]}
{"id": "cm-rack-to-near", "cat": "Focus", "dur": 3.5, "k": [[0, "Smooth", {"camDofEnabled": 1, "camFocusDistance": 2800, "camFocusX": 68, "camFocusY": 48, "camAperture": 36, "camBlurLevel": 110, "camHighlightGain": 18}], [22, "Smooth", {}], [78, "Smooth", {"camFocusDistance": 1350, "camFocusX": 35, "camFocusY": 55}], [100, null, {}]]}
{"id": "cm-rack-to-far", "cat": "Focus", "dur": 3.5, "k": [[0, "Smooth", {"camDofEnabled": 1, "camFocusDistance": 1350, "camFocusX": 35, "camFocusY": 55, "camAperture": 36, "camBlurLevel": 110, "camHighlightGain": 18}], [22, "Smooth", {}], [78, "Smooth", {"camFocusDistance": 2800, "camFocusX": 68, "camFocusY": 48}], [100, null, {}]]}
{"id": "cm-focus-chase", "cat": "Focus", "dur": 6, "k": [[0, "Smooth", {"camDofEnabled": 1, "camFocusDistance": 1450, "camFocusX": 28, "camFocusY": 55, "camAperture": 30, "camBlurLevel": 95, "camHighlightGain": 12}], [45, "Smooth", {"camFocusDistance": 2600, "camFocusX": 72, "camFocusY": 42}], [100, null, {"camFocusDistance": 1750, "camFocusX": 48, "camFocusY": 50}]]}
{"id": "cm-macro-bloom", "cat": "Focus", "dur": 4.5, "k": [[0, "Smooth", {"camZoom": 1.05, "camDolly": 0, "camDofEnabled": 1, "camFocusDistance": 2500, "camFocusX": 50, "camFocusY": 50, "camAperture": 28, "camBlurLevel": 100, "camHighlightGain": 15}], [52, "Smooth", {"camZoom": 1.16, "camDolly": 100, "camFocusDistance": 1650, "camAperture": 46, "camBlurLevel": 125, "camHighlightGain": 32}], [100, null, {"camZoom": 1.23, "camDolly": 180, "camFocusDistance": 1150, "camAperture": 38, "camBlurLevel": 110, "camHighlightGain": 22}]]}
```

- **Loops** (`cm-orbit-pulse`, `cm-float`, `cm-figure-eight`) end on their first snapshot, so they repeat seamlessly.
- **Focus:** `cm-rack-to-near`, `cm-rack-to-far` and `cm-focus-chase` animate depth of field only, so they compose with the camera's pose and a rig. `cm-macro-bloom` also pushes `camZoom` and `camDolly`, so it resets the pose and flips a rig to `"free"`.
- **`cm-punch-through`** (8.7 s, dolly only, `sparse`) writes one `camDolly` track and nothing else, so it composes with the pose the camera already holds: a linear creep from dolly 98 to 235 over the first 71 %, then one custom segment that detonates to 2600. On a 1080-tall project `perspectiveDistance ≈ 2166`, so the last instant flies **through** the comp plane and the frame blows out — that is the move, not a bug; park layers on negative `panZ` to stop the camera short of them.

### Camera Rig — a parametric camera move

A camera item's `cameraMoveMode` picks one of four exclusive modes: `"free"` (position/rotation keyframes), `"path"` (the drawn [camera path](#camera-motion-paths-camerapath--campatht)), `"rig"` (`item.cameraRig`) and `"smartZoom"` (Smart Zoom: zoom ranges, from a screen recording's clicks or placed by hand — see [Smart Zoom](#smart-zoom--the-cameras-zoom-mode)). An unknown value reads as `"free"`. An **absent** field also behaves as free, except that a live `cameraPath` still drives the camera. **A rig writes no path**, so switching modes never destroys a drawn curve.

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

**`follow` — a drone that rides an object.** The rig's orbit maths are re-based onto a followed layer's position: the camera keeps looking at it while `radius`/`height`/`startAngle`/`sweep` place and circle it, and a **moving** target drags the whole move with it. `targets` is an array of layer **item ids** (any positioned layer — not audio/voice); the keyframable camera track **`camFollowTarget`** (1-based, default `1`) names which entry the camera looks at. A key from `1` to `2` pans the look-at from one object to the next smoothly with the key's easing — **fractional values blend the two targets' positions**, so the hand-off is a camera move, not a cut. With an empty `targets` list (or dangling ids) the rig degrades to a plain orbit of the comp centre. `camFollowTarget`, like `camPathT`, is a driver track: the rig reads it and never overwrites it. A target is followed where it actually renders — through its position tracks, an object Motion Path (`motionPath` + `motionPathT`) or keyframe parenting.

#### Rig parameters

**Values outside the range are clamped silently**:

| Key | Range | Default |
| --- | --- | --- |
| `radius` | `100`–`20000` px | `1800` |
| `height` | `−8000`–`8000` px | `400` (positive films from below the subject — a low hero angle; negative from above) |
| `startAngle` | `−360`–`360`° | `−40` (`0` = straight ahead) |
| `sweep` | `−720`–`720`° | `90` |
| `rise` | `−8000`–`8000` px | `0` |
| `distance` | `−20000`–`20000` px | `1200` |
| `turns` | `0.25`–`8` × | `1` |
| `tilt` | `−80`–`80`° | `−8` |
| `roll` | `−180`–`180`° | `0` |
| `amplitude` | `0`–`2000` px | `0` |
| `frequency` | `0`–`40` × | `0` |

`seed` (default `7`, an integer clamped to 0–100000) only re-rolls the `handheld` jitter. `targets` (default `[]`, max 50 ids) is the `follow` type's hand-off list; junk entries are dropped by the sanitizer. `aim` is `"center"` (default) or `"path"`.

**`radius` sets the framing.** The project camera films the frame at its own size from the perspective distance `(height / 2) / tan(14°)` (a 28° field of view): about **2166 px for a 1080-tall frame** and **3850 px for a 1920-tall one (9:16)**. A rig closer than that crops in, farther pulls back — so the default `1800` already crops a 16:9 frame a little and a vertical 9:16 one hard; set `radius` near the frame's distance unless the push is the point.

**Rig parameters are NOT keyframable** — keying `radius` would rebuild the whole move every frame. **`camPathT` (Path Progress) is the track that carries the move**, and a rig with no `camPathT` keys sits frozen at its start pose. Always emit `camPathT` 0 → 100 alongside a `cameraRig`:

```json
"propertyKeyframes": { "camPathT": [
  { "position": 0, "value": "0", "easing": "Linear" },
  { "position": 100, "value": "100", "easing": "Linear" }
] }
```

`Linear` progress gives constant speed along the move, which is what the editor itself writes; an eased progress (`"Smooth"`, `"AE Smooth"`) makes the camera crawl at both ends, so use one only when that slow start and landing is the intent. A key without a numeric `position` is dropped when the project loads, which leaves the rig frozen exactly as if no track had been sent.

**`aim` picks what the camera faces.** `"center"` (the default, also when the key is absent) aims at the point the rig is built around — the comp centre, or the followed layer for `follow`. `"path"` faces the direction of travel. It suits moves that travel toward or past the subject (`pushIn`, `dolly`, `crane`, `truck`); on an `orbit` or `spiral` it looks along the circle, roughly 90° away from the subject. A rig that does not move (zero `sweep`/`distance`, a `handheld` with `amplitude` 0) keeps the centre aim. `aim` is a choice about the shot's framing, not part of a preset: keep the current value when emitting a preset over an existing rig, as with `targets`.

**`tilt` moves the AIM POINT, not the camera's own rotation**, so the subject stays framed as the rig travels. With `"aim": "path"` the same lift tips the gaze above or below the direction of travel. `handheld` jitter is a pure function of `seed` and progress — never wall-clock — so preview and export match frame for frame.

**Flat layers have a front.** Text, shapes, pictures and video are flat cards: an orbit that swings more than about 75° off the front (`startAngle` + `sweep` past ±75°, with `startAngle: 0` = straight ahead) turns them edge-on, and past 90° the camera sees their backs and they read mirrored. Keep orbits of flat layers within about ±70°: `heroOrbit` (−40° → +50°) stays inside; `slowReveal` (−120° → +30°) and `chaseCam` (from 160°) start past it, and `turntable`'s full circle is for 3D models.

#### Built-in rigs

The editor's twelve rig presets. Fields not listed take the defaults in [Rig parameters](#rig-parameters), so a preset is applied **whole**: write every field, or a partial rig keeps the previous shot's radius. Follow presets carry **no `targets`** — which layers to ride is project wiring, and applying any preset keeps the current list (and `aim`); do the same when you emit one over an existing rig.

| Preset | `type` | `radius` | `height` | `startAngle` | Type-specific | `tilt` |
| --- | --- | --- | --- | --- | --- | --- |
| `heroOrbit` | orbit | 1800 | 400 | −40 | sweep 90 | −8 |
| `slowReveal` | orbit | 2400 | 220 | −120 | sweep 150 | −4 |
| `turntable` | orbit | 1500 | 300 | 0 | sweep 360 | −6 |
| `craneDown` | crane | 1700 | 1400 | −30 | sweep 55, rise −1100 | 14 |
| `riseReveal` | crane | 1900 | 150 | −60 | sweep 80, rise 1200 | −16 |
| `pushIn` | pushIn | 900 | 260 | 0 | distance 1800 | −3 |
| `pullBack` | dolly | 2600 | 380 | 12 | distance −1700 | −6 |
| `truckLeft` | truck | 1600 | 300 | 0 | distance 2200 | −4 |
| `productSpiral` | spiral | 2800 | 240 | −20 | sweep 300, turns 1, rise 800 | −16 |
| `handheldDrift` | handheld | 1500 | 320 | −8 | amplitude 90, frequency 1.5 | −5 |
| `droneFollow` | follow | 1600 | 420 | −35 | sweep 110 | −7 |
| `chaseCam` | follow | 950 | 170 | 160 | sweep 35 | −4 |

#### Mode precedence

**A rig or a live path BEATS the pose keyframes.** The camera reads its tracks first; then a rig (mode `"rig"`) or a live path (mode `"path"` or absent) overwrites `camX`, `camY`, `camDolly` — plus `camTiltX`/`camTiltY`/`camRoll` whenever an aim is computed. So on a rigged camera, `camX`/`camY`/`camDolly`/tilt/roll keyframes are stored, drawn in the timeline, and **render as nothing**. `camZoom`, the whole depth-of-field family, `camPathT` and `camFollowTarget` are untouched by both and compose freely. To emit a pose move, emit `"cameraMoveMode": "free"` explicitly with it (omitting the field leaves a live `cameraPath` in control). The editor enforces the same rule by flipping the mode to `"free"` when a camera preset that animates those props is applied, keeping `cameraRig` and `cameraPath` on the item so switching back restores the move.
