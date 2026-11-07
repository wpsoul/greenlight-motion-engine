> **GreenLight Motion Engine:** this is the GreenLight Dash Video Editor's project format, which the engine reads as is.
> Ignore the `/api/...` routes and the app UI described here: in the engine you edit `project.json` (or `apply`) and run
> `npx greenlight-motion build`; what `GET /api/video-editor/capabilities` returns there is `npx greenlight-motion schema <topic>`
> here. `frontend/src/…` paths are files of the engine's public source repository. MotionFast templates (`mediaType: "motion"`)
> stay in GreenLight Dash.

# GreenLight Dash — Video projects and timeline basics

> Part of the greenlight-dash skill. Read this shared contract before editing a timeline, then only the relevant topic in README.md (GreenLight Dash only). Do not load every video reference.

## Contents

- [Editing and verification](#editing-and-verification)
- [Text animation pace](#text-animation-pace): a pointer to design.md
- [Video Projects (per board)](#video-projects-per-board): [list](#list-video-projects) · [get](#get-video-project) · [card](#project-card-what-a-canvas-card-shows) · [create](#create-video-project) · [update](#update-video-project) · [collaborative boards](#on-a-collaborative-board) · [refresh revision](#watch-for-editor-project-changes) · [activate](#activate-video-project) · [delete](#delete-video-project) · [build from clips](#build-a-project-from-a-flat-list-of-clips-agent-friendly)
- [Editor `data` shape](#editor-data-shape-for-postput-video-projects): [channel order](#channel-order-is-stacking-order) · [one live item per channel](#one-live-item-per-channel) · [sorted unsnapped items](#keep-unsnapped-items-sorted-by-freestart) · [preview source](#preview-source) · [screen recordings](#screen-recordings) · [scale](#layer-scale-is-three-fields) · [grade (`filter*`)](#layer-grade--the-static-filter-fields) · [blend mode](#blend-mode) · [mirror](#mirror) · [layer titles](#layer-titles) · [real-size media](#videos-and-photos-draw-at-their-real-size) · [Fit screen](#fit-screen) · [SVG](#svg-clips-are-vector-layers) · [GIF / WebP / APNG](#animated-image-clips-gif-animated-webp-apng) · [timeline markers](#timeline-markers) · [layer markers](#layer-markers) · [colour tokens](#design-tokens-project-colour-palette) · [photo slots](#photo-slots-pictures-people-may-replace) · [background](#project-background) · [motion blur](#motion-blur-render-only) · [renderer](#renderer) · [sound and fades](#sound--audio-fades)
- [Sequence clips](#sequence-clips-mediatype-sequence)
- [Video presets](#video-presets-save--load-reusable-sequences)
- [Project export and import (.zip bundles)](#project-export-and-import-zip-bundles)
- [GreenLight Motion pages (Export for agents)](#greenlight-motion-pages-export-for-agents)
- [Interface scenes (the UI kit)](#interface-scenes-built-in-animated-scenes--the-ui-kit)

Use `GET /api/video-editor/capabilities` for the installed build's effect and transition ids, fields, ranges and render support. Read the relevant subtree instead of copying a catalog into the prompt. For custom MotionFast authoring, use the authoring skill (GreenLight Dash only).

## Editing and verification

1. GET the project and retain its top-level `version` separately from `data.version` (the editor schema version).
2. Modify only the requested fields, preserving unrelated clips, channels, items, assets and metadata. Keep every simultaneously visible layer on its own channel.
3. PUT the full updated `data` with `expected_version` from that GET. Resolve a 409 by fetching and reapplying the intended edit; never force a stale snapshot through.
   The user may be editing the same project while you work. The open editor merges your write into their unsaved timeline layer by layer, so their work and yours both stay. Only when you both changed the same layer (or the same project setting) does it ask the user which to keep. So change only the layers your task needs: a write that rewrites every layer collides with whatever the user is touching.
4. GET again to verify the saved structure. For visible changes, check a composited still (`/render-still` (GreenLight Dash only)): a successful save alone does not prove an effect or track renders.
5. Keep all media used by the project, including nested sequences and effect assets, even when it has no canvas card. Follow media cleanup (GreenLight Dash only).

## Text animation pace

Text that animates in, out or gets a one-time pass takes at least 0.8–1 s by default. The rule, the arithmetic per kind of animation and the exceptions are in [video-design.md](video-design.md#text-animation-pace).

## Video Projects (per board)

A "video project" is a saved video-editor session inside a board.

### List video projects

```
GET /api/moodboards/{board_id}/video-projects[?data=active|none]
→ { "projects": [{ "id", "name", "data", "updated_at", "summary", "preview", ... }], "active_project_id?" }
GET /api/video-projects/counts
→ { "counts": { "<board id>": <number of projects>, … } }   (boards without projects are left out)
```

`?data=active` leaves out every payload except the open project's (`data: null`, `has_data: false`) and `?data=none` leaves out all of them, so they are the cheap ways to survey a board: each project still carries `summary`, which answers "how long is it, how big, how busy" without downloading timelines. The single-project GET / POST / PUT answers carry both fields too. Both are derived and read-only — never send them back.

- `summary`: `{duration, width, height, layers, clips, markers, background, media}` — timeline length in seconds (speed curves approximated), canvas size, channels that hold items, item count, marker count, the solid background colour (or null), and the first picture on the timeline.
- `preview`: null, or any of `thumbnail` + `thumbnailVersion` (a ~480 px frame of the project as it was last left after changes, and the project version it shows) and `frames` + `framesDuration` + `framesAt` (one JPEG strip of five frames side by side, cut from the last full-project render at `framesAt[i] × framesDuration` seconds). The URLs live under the board's `.project-previews/`.

### Get video project

```
GET /api/moodboards/{board_id}/video-projects/{project_id}
```

### Project card (what a canvas card shows)

```
GET /api/moodboards/{board_id}/video-projects/{project_id}/card
→ { "id", "board_id", "board_name", "name", "version", "updated_at", "summary", "preview" }   404 once removed
```

The project without its payload, plus its board's name: what a `video-project` canvas card shows (elements.md (GreenLight Dash only)). Use it to check that a board/project pair exists before making a card.

### Create video project

```
POST /api/moodboards/{board_id}/video-projects
{ "name": "Cut 01", "data": { ... }, "activate?": true }
```

A new project becomes the board's open one (the Video Editor opens it next). Send `"activate": false` when the project is for later, e.g. behind a canvas card, so the user's editor keeps the project it has.

### Update video project

```
PUT /api/moodboards/{board_id}/video-projects/{project_id}
{ "name?": "...", "data?": { ... }, "expected_version": 7 }
```

`PUT` the complete updated `data` object back through this endpoint; do not edit
the SQLite database directly. Create/update/activate/delete calls notify an open
Video Editor automatically, so the timeline picks agent changes up within a
couple of seconds.

`expected_version` is optimistic concurrency: pass the `version` field from the
`GET` you built your payload on and the write is rejected with **409** if the row
moved on in between (someone saved while you were working). **Always send it when editing an existing project.** Although the API accepts
an omitted version, that makes the write unconditional and can overwrite changes
saved since your GET.

On **409**, GET the latest project, reapply only your intended changes to that
fresh `data`, and PUT with its new `version`. Never retry the stale full payload
or drop `expected_version` to force it through. If the same fields changed and
the intended merge is unclear, describe the conflict and ask which edit to keep.

**Your write is never silently overwritten.** The editor sends `expected_version`
on every save, so a save built before your write is rejected rather than applied
on top of it. What happens on screen depends on the user:

-   **Editor open, no unsaved edits** (the normal case, including while they are
    just scrubbing the playhead or selecting clips) — your change is applied to
    the open timeline within ~2s. Nothing to do.
-   **Editor has unsaved edits** — the change is held rather than applied, since a
    reload would discard the open timeline and its undo history. Your version
    stays on the server until the user resolves it, and may deliberately be
    replaced by theirs. The editor cannot autosave over you meanwhile.
-   `GET` returns the last **saved** copy, which can be behind what is on the
    user's screen. With GLAI open in the editor it flushes every ~5s, so in that
    workflow you are reading current state. Long agent runs are the risk: if the user keeps editing
    while you work, re-`GET` before the final `PUT` rather than writing a payload
    built from a read you took minutes ago.

### On a collaborative board

Projects there are shared with every member: a create, `PUT` or delete reaches
the others within seconds, and a teammate's save can move `version` on at any
time — re-`GET` before each follow-up edit. A media URL like
`/api/collab/assets/{room}/{sha256}/{name}?missing=too_large&size=N` is a file
over the room's 50 MB limit that exists only on the machine that added it
(`withheld` = its proxy, `unavailable` = already gone there); it answers 404 and
renders empty here. Keep such URLs unchanged when you `PUT`: the owning machine
maps them back to its own file by hash, so removing or "repairing" the clip
deletes it from everyone's project.

### Watch for editor project changes

```
GET /api/moodboards/{board_id}/video-projects-refresh-revision
→ { "revision": 3, "actor": null }
```

This lightweight signal is for UI clients. Agents normally do not need to call
it: successful project mutation endpoints bump it automatically.

### Activate video project

```
POST /api/moodboards/{board_id}/video-projects/{project_id}/activate
```

No request body.

Sets the board's `active_video_project_id`.

### Delete video project

```
DELETE /api/moodboards/{board_id}/video-projects/{project_id}
→ { "ok": true }
```

### Build a project from a flat list of clips (agent-friendly)

```
POST /api/moodboards/{board_id}/video-projects/from-clips
{
  "name?": "Step compile",
  "width?": 1920, "height?": 1080,
  "activate?": true,                # also set this project as the board's active one
  "clips": [
    {
      "url": "/media/admin/{board_id}/step1.mp4",   # required
      "name?": "Step 1 result",
      "media_type?": "video"|"image"|"audio",        # optional; auto-detected from the URL extension when omitted
      "duration?": 5.0,                              # used as both clip.duration and the default trim window
      "trim_start?": 0,
      "trim_end?": null,                             # defaults to duration
      "transition?": "None"|"Cross Fade"|"Push"|"Wipe"|...,   # transition INTO this clip (ignored for the first clip)
      "transition_direction?": "left"|"right"|"up"|"down",    # Push / Parallax; Wipe: "leftToRight"|"rightToLeft"|"bottomToTop"|"topToBottom"
      "transition_duration?": 1.0,
      "transition_easing?": "Smooth"|"Linear"|"Ease In"|...,
      "transition_order?": "Next over previous"|"Previous over next",   # which clip animates over the other
      "proxy_url?": "...",
      "thumbnail_url?": "..."
    }
  ]
}
→ { "id", "name", "data": { ...full editor state... }, "activated": bool, ... }
```

Use this to assemble the workflow's per-step videos into a project in one call without having to construct the editor's `clips`/`channels`/`items` shape by hand. **Media type is derived from each `url`'s file extension** (`.png/.jpg/.gif/.webp/...` → `image`, `.mp4/.webm/.mov/...` → `video`, `.mp3/.wav/...` → `audio`); pass `media_type` only to override. Do **not** assume every clip is a video — mixing images and videos in one `clips` list is fully supported, and a wrong type breaks the server-side `/render` (which dispatches on `mediaType`). Before choosing `transition` or `transition_easing`, call `GET /api/video-editor/capabilities` and use `transitions.cross.builtIn[].value` plus `easings.keyframe.transitionValues`. Unknown values → 400. This helper accepts built-ins; installed executable transitions are authored in the full project shape.

### Editor `data` shape (for `POST/PUT video-projects`)

The video-editor `mediaType` values are:

- `video`, `image`, `audio`, `text`, `shape`, `adjustment`;
- `sequence`: a compound clip, see [Sequence clips](#sequence-clips-mediatype-sequence);
- `grid`: Grid Builder, a container that lays its members out by a rule, see [video-grid.md](video-grid.md);
- `motion`: a native MotionFast animated template, see motion.md (GreenLight Dash only);
- `model3d`: a live 3D model rendered in its own pass, see [video-3d.md](video-3d.md). Its clip `url` must be a `model-preset:` or `model-primitive:` sentinel or a real asset URL, **never empty**;
- `rig`: the Scene Rig (one set for every 3D layer), see [video-3d.md](video-3d.md#scene-rig--one-set-for-every-3d-layer);
- `particles`: a seeded particle simulation in a Solver Box, filmed by the project camera, see [video-particles.md](video-particles.md). The whole system lives on the ITEM as `particleSystem`;
- `camera`: a virtual camera over the whole stack, see [video-camera.md](video-camera.md);
- `html`: an HTML page as a layer, see html-clips.md (GreenLight Dash only);
- `after-effects`: a render of one After Effects composition, see ae-clips.md (GreenLight Dash only);
- `null`: a transform with no picture, never drawn in any render; the parent other layers hang off, see [Layer parenting and null layers](video-keyframes.md#layer-parenting-and-null-layers-keyframeparenting). Its clip `url` is `""`; the item's `nullColor` (default `#ff3b30`) and `nullSize` (marker diameter in composition px, 2–2000, default 24) style only the editor's preview marker.

Any other value loads as `video`, and a `video` clip whose url is an audio file loads as `audio`. A clip of a type that needs a file (`video`, `image`, `audio`, `model3d`, `html`, `after-effects`) is dropped on load when its `url` is empty. A **device mockup** is not its own `mediaType`: it is a rendered `video` clip that may carry a `mockupConfig` for re-editing (see motion.md (GreenLight Dash only)). Which render path draws which type: rendering.md (GreenLight Dash only).

If you need to build the editor state by hand instead of using `/from-clips`, start from this minimum shape; the editor fills in the rest when it loads:

```json
{
  "version": 2,
  "videoSize": { "w": 1920, "h": 1080 },
  "motionBlurEnabled": false,
  "clips": [
    { "id": "c1", "source": "REMOTE", "mediaType": "video", "url": "/media/admin/{board_id}/a.mp4", "name": "A", "duration": 5 }
  ],
  "channels": [
    { "id": "ch1", "name": "Channel 1", "visible": true, "items": [
      { "id": "i1", "clipId": "c1", "trimStart": 0, "trimEnd": 5,
        "transition": "None", "transitionDuration": 1, "transitionEasing": "Smooth" }
    ] }
  ],
  "activeChannelId": "ch1",
  "selectedTimelineId": null,
  "currentTime": 0
}
```

`data.version` is the editor's schema version (2); keep what the GET returned. A clip may also carry `proxyUrl`, `thumbnailUrl` and `previewOriginal`, and an item `transitionOrder` ([video-transitions.md](video-transitions.md#transition-fields)); every field you leave out takes its default.

#### Channel order is stacking order

Channels composite in array order: the **last** channel in `channels` is drawn on top. Put the footage channel first and the titles, captions and overlays after it; to put a new layer above everything, append its channel at the end.

#### One live item per channel

Treat every channel as one timeline track, not as a container of simultaneously composited layers. At any timeline time, a channel may have at most one active item. If two items' visible windows overlap, only one is guaranteed to render (the later-starting item commonly wins) and the save API does not reject the project. For an unsnapped item, its ordinary visible window is `[freeStart, freeStart + (trimEnd - trimStart))`; validate these windows before `PUT`. Put every simultaneously visible image, shape, text block, motion layer, or other visual on a separate channel. This rule also applies inside sequence timelines. Reuse one channel for consecutive, non-overlapping captions or shots only.

#### Keep unsnapped items sorted by `freeStart`

On an `unsnapped` channel the editor treats the item BEFORE a clip in the `items` array as "the clip before it": cross transitions and the layout's overlap read array neighbours, not time neighbours. The editor re-sorts on every insert, move and paste; an API write does not. After adding or moving items, sort each unsnapped channel's `items` by `freeStart` before `PUT`. An out-of-order array looks fine until the user adds a cross transition: the clip is then snapped against the wrong neighbour and jumps elsewhere on the timeline (e.g. past the end), so it appears to vanish.

#### Preview source

`"previewOriginal": true` on a clip makes the editor preview play the full-res original instead of its `proxyUrl` — sharper when scale/crop keyframes zoom in, at a heavier decode cost. Preview-only: every render path already uses the original.

#### Screen recordings

A recording clip carries `recordingMeta` (its clicks and a light cursor path, in seconds of the file) and may carry `recordingTrackUrl` (the full-rate `.glcursor` beside it) and `recordingMeta.cursorInVideo: false` (no cursor in its picture: the editor draws one). Its camera is a Smart Zoom item, and its item's `recordingCursor` sets the drawn cursor's look. Both are in [camera.md](video-camera.md) ("Smart Zoom" and "Drawn cursor").

#### Layer scale is three fields

`zoom` is the uniform scale (0.1–20, default 1), and `scaleX` / `scaleY` (same range, both default 1) are per-axis multipliers on top of it — so a layer's drawn width is `zoom × scaleX` and its height `zoom × scaleY`. Use `zoom` alone for an ordinary resize; reach for the other two only to stretch or squash one axis (a wide title bar, a squash-and-stretch bounce). All three inherit through layer parenting. Every one of them also has a keyframe track (`scale`, `scaleX`, `scaleY` — see [video-keyframes.md](video-keyframes.md)), which multiplies the base field rather than replacing it. A missing `scaleX`/`scaleY` is 1.

#### Layer grade — the static `filter*` fields

Every visual item carries a CSS-style grade applied to the layer before it composites: `filterBlur` (px, 0–10, default 0), `filterBrightness` / `filterContrast` / `filterSaturation` (%, 0–200, default 100), `filterHueRotate` (deg, 0–360, default 0), `filterGrayscale` / `filterSepia` / `filterInvert` (%, 0–100, default 0; Invert at 100 is a full negative). These are the layer's own base values; the matching keyframe tracks (`blur`, `brightness`, `contrast`, `hue-rotate`, `saturate`, `grayscale`, `sepia`, `invert`) **override** the static field while the track exists rather than multiplying it, so key one or set the other, not both. They are a cheap per-layer grade and independent of the Overlay Effects chain — reach for `effects[]` when you need a real grade (curves, LUT, colour balance).

#### Blend mode

`blendMode` is any Photoshop mode, by camelCase id: `"normal"` (default), `"dissolve"`; `"darken"`, `"multiply"`, `"colorBurn"`, `"linearBurn"`, `"darkerColor"`; `"lighten"`, `"screen"`, `"colorDodge"`, `"add"` (Linear Dodge), `"lighterColor"`; `"overlay"`, `"softLight"`, `"hardLight"`, `"vividLight"`, `"linearLight"`, `"pinLight"`, `"hardMix"`; `"difference"`, `"exclusion"`, `"subtract"`, `"divide"`; `"hue"`, `"saturation"`, `"color"`, `"luminosity"`. `opacity` works with all of them. Two implementations, same result in preview and every render path: `multiply` / `screen` / `add` / `lighten` / `darken` are GPU hardware blends with no extra pass (the source is faded toward the mode's neutral colour first; exact for multiply/screen/add, monotonic approximations for lighten/darken), and every other mode reads the layers below in a shader, which routes the layer through the compositor's isolate branch — one extra full-frame pass per such layer, so prefer the hardware five where they give the look you want on a heavy project. A shader-mode layer composites flat: inside a real-3D frame it does not depth-test against other layers for that frame. Text layers ignore the hardware five (they composite Normal) but take every shader mode. Every mode works on a layer that also carries `layerEffects`.

#### Mirror

`mirrorH` / `mirrorV` (booleans, default false) flip the layer's picture on its own axes, after scale and before rotation. Not the same as a negative scale — they never change the layer box, so framing, masks and child layers are unaffected.

#### Layer titles

Optional `"customName"` on any timeline item — the display title drawn on the clip in the timeline in place of the clip/media name. Trimmed string, max 120 chars; empty or missing falls back to the default (the clip's `name`, or the text content for text layers). Set it whenever you build or edit a timeline so layers are self-describing — `"Intro logo"`, `"CTA caption"`, `"BG loop"` — instead of raw filenames; a rename in the editor writes the same field. Display-only: no render path reads it.

#### Videos and photos draw at their real size

A `video` clip (like a bitmap `image`) keeps its own aspect ratio and never gets bars: larger than the composition, it is shrunk to fit; smaller than the composition on both axes, it keeps its pixel size. A 1280×720 clip in a 1920×1080 project covers 1280×720 at `zoom: 1` (set `zoom: 1.5` to fill the frame), and a 1080×1920 clip in a 16:9 project is a centred portrait picture. Whatever the picture does not cover shows the layers below, or the project background.

#### Fit screen

To make a video or image layer's whole picture fit the frame, call `POST /api/moodboards/{board_id}/video-projects/{project_id}/fit-screen` with `{"itemId": "<item id>"}` (the item can be inside a sequence). It reads the media's real size on the server and saves the project: `zoom` becomes the fitting Scale (`max(1, min(compW/mediaW, compH/mediaH))` for a video or photo, `min(compW/w, compH/h)` of the declared size for an SVG), `scaleX`/`scaleY` become 1 and `panX`/`panY` 0. Rotation and keyframes are kept; `scale` keyframes multiply the new `zoom`. Answer: `{itemId, zoom, mediaWidth, mediaHeight, frame, version}`. 400 for a layer that is not a video or image, 422 when the media size cannot be read.

#### SVG clips are vector layers

An `mediaType: "image"` clip whose `url` ends in `.svg` (or is an `image/svg+xml` data url) is **not** letterbox-fitted to the frame like a bitmap: it is laid out at the size the document itself declares (`width`/`height`, else the `viewBox`, else 300×150 by CSS default sizing) and re-rasterized at whatever resolution it ends up covering, so it stays sharp under any `zoom` or camera push-in. Consequences when authoring: a 200×80 logo occupies 200×80 composition px at `zoom: 1` — set `zoom` (or scale keyframes) to size it, never assume it fills the frame; artwork larger than the composition overflows it. Everything else is an ordinary image clip (filters, transitions, effects, keyframes). An SVG loaded this way cannot reach external resources — fonts must be outlined and images embedded, the same restriction any `<img>`\-loaded SVG has.

#### Animated image clips (GIF, animated WebP, APNG)

An `mediaType: "image"` clip whose `url` is an animated GIF, animated WebP or APNG plays as a moving picture instead of freezing on its first frame. Which frame shows is a pure function of the item's clip-local time, so preview and every render agree, and it is resolved from the file's own per-frame delays rather than an assumed frame rate — a file built around one long hold frame plays at the rate it was authored at. Two optional fields on the **item** control playback: `"gifLoopMode"` — `"loop"` (default, restart at the end), `"hold"` (freeze on the last frame) or `"pingpong"` (forwards then backwards) — and `"gifSpeed"`, a playback multiplier from 0.1 to 10, default 1, which changes only how fast the animation runs inside the clip and never the clip's length on the timeline. Both are dropped from the persisted JSON at their defaults, and a value outside those ranges is clamped on load. Set the clip `duration` (and the item's `trimEnd`) to the file's loop length for exactly one play-through — a longer span loops, a shorter one cuts — and `trimStart` offsets where the animation starts. Everything else is an ordinary image clip: plate sizing, filters, transitions, masks, effects and keyframes are unchanged, and still images are unaffected. The fast `/render` fails on an animated file, so render a timeline holding one with `/render-onserver` (what each render path bakes (GreenLight Dash only)).

#### Timeline markers

Optional `"markers": []` at the `data` root — annotations on moments in the timeline (beat points, section starts, review notes). Each marker is `{ "id": "<unique string>", "time": <seconds ≥ 0>, "color": "#rrggbb", "name": "<label, ≤120 chars>" }`. `time` is absolute timeline seconds (a marker past the last clip is legal and kept). `color` must be a hex string; the palette is the 20 canvas label presets (`#ef4444 #f97316 #f59e0b #eab308 #84cc16 #22c55e #10b981 #14b8a6 #06b6d4 #0ea5e9 #3b82f6 #6366f1 #8b5cf6 #a855f7 #d946ef #ec4899 #f43f5e #78716c #6b7280 #94a3b8`), default `#8b5cf6` — other hex values load fine but are outside the palette. `name` may be empty. Read/create/move/recolor/rename/delete them by editing this array and `PUT`ting `data` back; invalid entries (missing/negative `time`, non-hex `color`) are dropped on load and duplicate `id`s are de-duplicated. The array is omitted from the persisted JSON when empty. Annotations only — every render path ignores them.

#### Layer markers

Optional `"layerMarkers": []` at the `data` root — the same pin attached to one **clip** instead of to the whole project ("the logo lands here", "cut this shot on this frame"). Each entry is `{ "id": "<unique string>", "itemId": "<an existing timeline item id>", "position": <0–100>, "color": "#rrggbb", "name": "<label, ≤120 chars>" }`. `position` is a percentage offset **inside that item**, the same coordinate `propertyKeyframes` use — **not** timeline seconds. Nothing stores an absolute time; it is derived from the item's current placement, which is why a marker travels with its clip when the clip is moved, trimmed or re-timed. To place one at timeline second `t` on item `i`, compute `position = (t - i.startTime) / i.duration * 100` from the channel layout. Same palette, default colour `#14b8a6`. On load, entries with a missing/blank `itemId` or a non-numeric `position` are dropped, as are entries whose `itemId` no longer matches a live item (a deleted clip or layer takes its markers with it). The array is omitted from the persisted JSON when empty, and like `markers` it is ignored by every render path.

#### Design tokens (project colour palette)

Optional `"colorTokens": []` at the `data` root — the handful of colours this project reuses (brand, accent, caption bar). Each entry is a **colour string**: `#rgb`, `#rrggbb`, `#rrggbbaa`, or `rgb()`/`rgba()`. Max 24; entries that don't parse are dropped on load and the array is omitted from the persisted JSON when empty. Duplicates are kept as written. Purely an authoring palette for the editor, and **no render path reads them**: a token is not a reference, so setting `colorTokens` does not retint anything on its own.

Agent rules: when the user asks for "the project's colours", "brand colours" or a palette, read `data.colorTokens` and **copy the literal values** into the fields you are setting (`textColor`, `shapeFillColor`, `background.solidColor`, animator colours (`textAnimators[].effects[].color`), effect colour params, …). When you introduce a colour the project will reuse, append it to `colorTokens` so it shows up in the user's pickers. Rewriting a token does **not** recolour layers that already used its value — change those fields too.

```json
{ "colorTokens": ["#8b5cf6", "#0ea5e9", "rgba(0, 0, 0, 0.6)"] }
```

#### Photo slots (pictures people may replace)

A picture layer (an item whose clip is `mediaType: "image"`) can carry
`"photoSlot": { "fill": "cover" | "fit", "focus": [x, y], "takes": "image" | "media", "series": true | false, "note": "…" }`
— a MARK only: no render path reads it. `fill` = cover the layer's box (edges may be cut) or show all of the photo;
`focus` = the point (0–1 inside the photo) a Cover crop keeps in view; `takes` = a photo, or a photo or a video;
`series: true` = one of the project's numbered slots, filled in PLAY order (by start time, not track order), `false` = a
slot on its own (a logo); `note` (≤ 300 chars) = what belongs there, for an agent. The box is the layer's own frame, so
moving or resizing the layer moves the slot. Optional `"photoSlotSettings": { "label": "Photos", "ifFewer": "reuse" | "keep" }`
at the `data` root names the series and says what slots with no photo show when people bring fewer photos than slots
(omitted while default).
Agent rules: to let people put their own photo in a picture, add `photoSlot` to its item (`{}` is enough — every field
has a default); keep the user's existing marks when you rebuild a layer; a slot is never empty — its current picture is
the example until someone replaces it.

#### Project background

Set `"background": { …backgroundConfig… }` at the `data` root to fill the stage behind every channel — a solid colour, gradient, GLSL shader, pattern, or image. It takes the same `backgroundConfig` object as shape backgrounds; the full schema, the gradient/shader preset ids and the shader authoring rules are in [video-backgrounds.md](video-backgrounds.md). Omit it (or use `"type": "transparent"`) for a transparent stage. The fast `/render` does not draw it (what each render path bakes (GreenLight Dash only)). A bare colour string (`"background": "#3366cc"`) is coerced to `{"type": "solid", "solidColor": …}`; prefer the explicit object.

#### Motion blur (render-only)

Set `"motionBlurEnabled": true` at the `data` root — a project-wide switch, not per layer — to bake cinematic shutter blur into full renders. The choice is made per output **frame**, not per layer: a frame where motion is detected is rendered as a multi-sample accumulation of the **whole composition** across a shutter window centred on the frame, so every layer that changes inside that window blurs (keyframed layers, text animators, motion layers, transitions, particles), not only the one that triggered it. A frame with no detected motion renders once and stays sharp, so cost only grows where motion exists.

A frame is accumulated when any of these change across its shutter window:

- the camera layer's pose (any camera track), or the frame enters or leaves a camera clip;
- a keyframed layer's resolved pose: its position, rotation or scale as drawn, from any track that places it (`translateX/Y/Z`, `xPercent`/`yPercent`, `rotate`, `rotateX/Y`, `scale`, `scaleX`/`scaleY`), and a live motion path's `motionPathT`, `motionPathOffsetX/Y/Z` or keyed path shape (adjustment-layer pan/zoom included);
- the parent of a parented layer, or the tracked point of a `motionFollow` layer;
- a `video` item with a speed curve (any `speedPoints` value other than 1): every frame of that item, the 1× stretches included;
- a particle system, or an `html` clip drawn live (the render default): every frame they are on screen;
- the inner timeline of a `sequence` clip, by the same rules, down to the 4-level nesting limit (parenting and `motionFollow` links inside a sequence are not read).

Nothing else triggers a frame by itself: text animators, MotionFast `motion` layers, 3D model animation, enter/exit and cross transitions, keyed opacity or effect params, and movement inside footage at normal speed. They blur on frames something in the list triggers and are sharp everywhere else.

**Strength** is `"motionBlurShutter"` — a **shutter angle in degrees** alongside `motionBlurEnabled`. Only these four values are meaningful; anything else (missing, non-numeric, an off-table angle) snaps to the nearest level, so `180` is the effective default:

| Angle | Level | Samples | Cost on moving frames |
| --- | --- | --- | --- |
| `90` | Subtle | 8 | ~8× |
| `180` | Normal — cinematic default | 16 | ~16× |
| `270` | Strong | 24 | ~24× |
| `360` | Max | 32 | ~32× |

The angle is how much of each frame interval the exposure covers, so wider = more blur *and* proportionally slower. The field is only stored while blur is on. Blur is baked by the full renders (`/render-onserver`, `/render-onserver-job`, the desktop Download) and never shown in the editor preview; the fast `/render` ignores it. Worth enabling for projects with fast zooms/pans that would otherwise strobe. Renders get proportionally slower on accumulated frames (~16× each at the default), and a speed-ramped clip, a particle system or a live html clip makes every frame it covers an accumulated one.

#### Renderer

Every project renders on the engine the app is set to — one app-wide setting, not a project field. Read it with `GET /api/video-editor/engine` (`engine`: `"webgl"`, the default, or `"webgpu"`). Preview and the desktop Download use it; the headless renders (`/render-onserver`, `/render-onserver-job`, `/render-still`) take it as the request's `"renderer"` field, which defaults to `"webgl"`, so pass the engine there to render what the editor shows. It matters wherever shading is written by hand rather than picked from a list: an uploaded Advanced Transition package is authored for one engine and is refused on the other, and a **custom** adjustment/layer effect (`"id": "custom"`) cannot run on WebGPU at all — its body is compiled at runtime, so the effect is skipped with a reason. Building a new template or transition: custom-builds.md (GreenLight Dash only).

#### Sound & audio fades

Clips with audio (`video` and `audio` media types) honor per-item `volume` (0–100 %, default 100). `volume` is the sound control: mute a layer with `volume: 0`, un-mute it with the level you want; `muted` only follows it (`true` exactly when `volume` is 0). A write that sets just `muted: true` is stored as `volume: 0` with the old level in `preMuteVolume`, and just `muted: false` on a muted layer brings that level back. Clips with audio also take an intro/outro fade: `audioFadeIn` / `audioFadeOut` (seconds of the item's **placed** span; 0/absent = off; only stored when > 0) plus one `audioFadeCurve` for both ends (`"linear" | "smooth" | "exponential"`; only stored when it differs from the `"smooth"` default). The envelope multiplies onto `volume`; on a clip shorter than its two fades they overlap and multiply into a bump that never reaches full level. Fades span the item's placed bounds, so a partial (`rangeStart`/`rangeEnd`) render keeps the same shape. Applied identically in preview and the full renders (desktop Download and `/render-onserver`); the fast `/render` cannot render `audio` clips (what each render path bakes (GreenLight Dash only)).

### Sequence clips (`mediaType: "sequence"`)

A **sequence** is CapCut's "compound clip": one timeline layer that plays its **own nested editor state** (its own `clips` + `channels`). In the parent timeline it behaves exactly like a video layer — `trimStart`/`trimEnd`, speed points, keyframes, filters, opacity, blend mode, and transitions all apply to the sequence as a whole. Sequences nest recursively up to **4 levels**.

A sequence clip carries the nested state in a `sequence` field and needs no `url`:

```json
{
  "id": "seq1", "source": "LOCAL", "mediaType": "sequence", "url": "", "proxyUrl": null,
  "name": "Intro block", "duration": 6,
  "sequence": {
    "clips": [
      { "id": "sv1", "source": "REMOTE", "mediaType": "video", "url": "/media/admin/{board_id}/a.mp4", "name": "A", "duration": 6 },
      { "id": "st1", "source": "LOCAL", "mediaType": "text", "url": "", "proxyUrl": null, "name": "Title", "duration": 5 }
    ],
    "channels": [
      { "id": "sch1", "name": "Video", "visible": true, "unsnapped": true, "items": [
        { "id": "si1", "clipId": "sv1", "freeStart": 0, "trimStart": 0, "trimEnd": 6 }
      ] },
      { "id": "sch2", "name": "Title", "visible": true, "unsnapped": true, "items": [
        { "id": "si2", "clipId": "st1", "freeStart": 1, "trimStart": 0, "trimEnd": 3, "textContent": "Hello" }
      ] }
    ]
  }
}
```

Rules:

- **Nested state is self-contained** — inner `items[].clipId` must reference ids inside `sequence.clips`, not the parent's `clips`. Inner channels/items use the exact same schema as top-level ones (text/shape/audio/video all allowed; sequences-in-sequences too).
- **`duration` is derived** — on load the editor recomputes the clip's `duration` from the nested channels' total length, so keep the nested timeline the length you want and set `duration`/`trimEnd` to match.
- Prefer `"unsnapped": true` + `freeStart` on inner channels — that's what the editor produces when it groups layers into a sequence.
- The parent timeline item referencing the sequence clip is a **normal item** (`{ "id", "clipId": "seq1", "trimStart": 0, "trimEnd": 6, ... }`) — trim it to show only part of the sequence, add keyframes/filters/transitions to affect the whole block.
- **A sequence with `essential`** is a built edit that carries its own recipe. There are two kinds:
  - **An AI Viral Edit:** `"essential": { "kind": "viral-edit", "v": 3, "recipe": { "settings", "analysisUrl" (or "analysis"), "cutoutUrl", "sourceUrl", "itemId", "editId", "W", "H", "fps", "at", "timeOffset", "duration" } }` (an edit with `"v": 1` or `2` becomes v3 when rebuilt).
    - The editor rebuilds the layers inside the sequence from the recipe whenever the user changes one of its settings. A rebuild replaces any hand edits made inside the sequence.
    - To change such an edit, rebuild it with the `viral-edits` workflow (its build step rebuilds in place). Edit its inner layers by hand only for a one-word change the user asked for.
  - **A HyperFrames scene** (made by Convert to scenes): `"essential": { "kind": "hyperframes-scene", "v": 1, "recipe": { "url", "sceneId", "label", "clipValues", "compositionVariables", "sceneVariables", "sceneDefaults", "values", "sceneValues" } }`.
    - Its per-scene values change only the `gl-vars` of the html pages inside the sequence; the layers, keys and camera stay.
    - To change the values, call `…/html-clips/{item_id}/hyperframes-scene-values` (hyperframes.md (GreenLight Dash only)). Do not edit the pages' urls by hand.
  - When you write the project, keep `essential` exactly as it is. Without it, the edit can no longer be rebuilt.
  - The editor drops an `essential` sequence clip from `clips` once no item uses it.
- **Rendering:** the full renders bake sequences in; the fast `/render` rejects them (what each render path bakes (GreenLight Dash only)). Adjustment layers inside a sequence composite (grade + effects chain + layer mask alike). Known nested limits: the project's global Depth of Field doesn't composite inside a sequence (a sequence's own camera clip's depth of field does: AI Viral Edits use it), and inner audio only exports when the sequence item plays at flat 1× speed.
- Keep ids unique across the whole document, inner timelines included.

### Video presets (save & load reusable sequences)

Presets are **global** (not per-board) JSON files under `media/video-presets/` — one file per preset. Format (`sequence` holds the `clips` and `channels` of a sequence clip, as in [Sequence clips](#sequence-clips-mediatype-sequence)):

```json
{ "version": 1, "kind": "ve-sequence-preset", "name": "Lower third", "duration": 4.0,
  "videoSize": { "w": 1920, "h": 1080 },
  "sequence": { "clips": [], "channels": [] } }
```

Endpoints:

```
GET    /api/video-presets                → { "presets": [{ "id", "name", "duration", "thumbnail_url?", "updated_at" }] }
GET    /api/video-presets/{preset_id}    → the full preset JSON (shape above)
POST   /api/video-presets                { "name", "duration?", "videoSize?", "sequence", "thumbnail?" }   # thumbnail = optional PNG data URL
PUT    /api/video-presets/{preset_id}    { "name?", "duration?", "videoSize?", "sequence?", "thumbnail?" }  # update a preset in place
DELETE /api/video-presets/{preset_id}
GET    /api/video-presets/{preset_id}/export           # download a .zip bundle: preset.json + every /media file the sequence uses
POST   /api/video-presets/import?board_id={board_id}   # multipart `file` = a preset .zip (or bare .json); bundled media is written into the board's dir and URLs are remapped
```

- **Save a preset** from an existing sequence clip: take the clip's `sequence` payload + `duration` and `POST` it with a name.
- **Load a preset into a project**: `GET` the preset, then add to the project `data` (1) a new sequence clip whose `sequence` is the preset's `sequence`, and (2) a timeline item referencing it on an `unsnapped` channel with a `freeStart`. **Generate fresh ids for every clip/channel/item in the preset payload first** (recursively, remapping inner `clipId` references) — inserting the same preset twice with original ids corrupts the project. Then `PUT` the project back and render with `/render-onserver`.
- **Cross-machine sharing**: use the export/import bundle endpoints above — export packs the referenced media files into the .zip, and import restores them (skipping byte-identical files that already exist) and remaps the URLs, so the preset plays anywhere.

### Project export and import (.zip bundles)

Video projects have the same bundle endpoints as presets:

```
GET    /api/moodboards/{board_id}/video-projects/{project_id}/export       # a .zip with project.json + every /media file it uses
POST   /api/moodboards/{board_id}/video-projects/import                    # multipart `file` = that zip, or a bare editor-state .json
POST   /api/moodboards/{board_id}/video-projects/{project_id}/export-job   # the same zip as a background job
GET    /api/video-project-export-jobs/{id}
DELETE /api/video-project-export-jobs/{id}
```

- `import` creates a NEW project in the board, with the media imported and the URLs remapped.
- The one-shot `GET .../export` answers only after the whole zip is written: minutes for a project with gigabytes of media, with no way to see progress or stop it. For big projects start a job instead. `export-job` returns at once with `{id, status, phase, progress, filesDone, filesTotal, bytesDone, bytesTotal, currentFile, missing, filename, downloadUrl}` (a project that is already exporting returns its running job).
- Poll `GET /api/video-project-export-jobs/{id}` until `status` is `completed`, `failed` or `cancelled`, then `GET` its `downloadUrl`. `missing` counts referenced media files that are gone from disk and were left out.
- `DELETE` cancels a running job or deletes a finished one's zip; a zip nobody deletes expires after an hour.

### GreenLight Motion pages (Export for agents)

A project leaves the app (`export-light`, below) as ONE of:
- **a `.glvideo` file** (`format: "glvideo"`): the project in one file, for a Claude chat (the GreenLight Motion
  connector's video page) or another GreenLight Dash (`import-light`). Layout below.
- **a GreenLight Motion Engine page** (`format: "folder"`, the API's default): a folder with `index.html` (plays the
  project in Chrome/Edge with nothing to install, with its layers, options and notes, and renders an MP4), `project.json` (the editor `data` above + `name`, `formatVersion: 1` and `template` — the options), and
  `assets/` (`assets/media/<rel>` = the board's `/media/<rel>` files under their original refs, `assets/hdr/`,
  `assets/models/`). For an agent on this computer that works on `project.json`.

Over the API:

```
GET  /api/moodboards/{board_id}/video-projects/{project_id}/light-report
     → { name, template | null, leftOut: [{ kind, reason, layers[] }], engine: bool, defaultDest }
POST /api/moodboards/{board_id}/video-projects/{project_id}/export-light
     { "dest?": "/abs/parent/folder", "template?": { "title", "fields": [ … ] },
       "modelFiles?": { "<preset id>": "<the URL the app serves its .glb at>" }, "format?": "folder" | "glvideo",
       "pack?": false, "smaller?": false, "progressId?": "<8–64 of A-Z a-z 0-9 ->" }
     → folder:  { folder, index, packed: { path, bytes } | null, files, bytes, missing, leftOut, fields, smaller }
     → glvideo: { format: "glvideo", glvideo: "<dest>/<title>.glvideo", folder: <dest>, bytes, files, missing, leftOut, fields, smaller }
GET  /api/video-projects/export-light/progress/{progressId}
     → { phase: waiting | files | page | done, done, total, file, converting }   (a .glvideo has no `page` phase)
POST /api/moodboards/{board_id}/video-projects/import-light
     { "path": "/abs/folder | …/index.html | a one-file page.html | a .glvideo file", "activate?": true }
     → the new project (like POST video-projects) + { copied }
GET  /api/moodboards/{board_id}/video-projects/{project_id}/glvideo?models=<JSON { "<preset id>": "<the URL the app serves its .glb at>" }>
     → <name>.glvideo (answers once the whole file is written; `models` as in export-light's modelFiles — without it the
       3D device presets are left out)
```

- A `.glvideo` is the same project folder in one stored zip: `glvideo.json` (`{format: "glvideo", version: 1, title}`),
  `project.json`, `assets/media/<rel>`, `assets/hdr/` and `assets/models/` (the 3D device presets the project uses). It
  is the file to hand a project to another GreenLight Dash (`import-light` with its path opens it there as a new
  project) or to a chat: the GreenLight Motion connector's `open_video` page reads it in the user's browser, and
  `get_video` / `edit_video` change it there.

- Each picture marked with `photoSlot` in the project (saved before the export) becomes an `image` field of the template
  (its clip's `url` + `proxyUrl`); the marks travel inside `project.json` with their layers.
- `template.fields[]` = `{ key, label, type: text|color|image|number|select|toggle, targets: [{ itemId | clipId | (neither = project), path }] }`
  — e.g. `{ "key": "headline", "label": "Headline", "type": "text", "targets": [{ "itemId": "<item id>", "path": "textContent" }] }`,
  a shape colour `path: "shapeFillColor"`, the background `{ "path": "background.solidColor" }`. Omit `template` to keep
  the project's saved one; `pack: true` (folder only) also writes one self-contained `.html` next to the folder (for a
  Claude artifact: keep it under 16 MB). `smaller: true` puts WAV sounds in as MP3 and PNG pictures as WebP (transparency
  kept) and points the exported project at them — the board keeps its originals; `smaller` in the answer is
  `{ sounds, pictures, before, after }`. The endpoint has no top-level `title`: name the export through `template.title`.
  A name already taken gets a number: `<title> 2.glvideo`, `<title> 2/`.
- The template is kept beside the project (`<board folder>/.motion/<project id>.template.json`), not in its `data`.
- `import-light` copies every file into the board (`motion-<title>/`), except a `/media/` file this machine already
  has byte for byte; the template comes back too. The page's `greenlightdash://open?path=…` link does the same
  (handled by the desktop app on the board that is open).
- `leftOut` names layers the page does not play (MotionFast templates, After Effects clips) — they stay in the data.

### Interface scenes (built-in animated scenes — "the UI kit")

The **Interface scenes** library holds 172 ready-made animated scenes (controls, cards, charts, checkout, coupons, countdowns, galleries…) in one style, all transparent (they sit over the video), each in a light or dark theme with an accent colour. Inserting one makes the scene one standalone transparent HTML page, saved into the board's media (`ui-kit/<id>.html`) and placed as an HTML clip (`mediaType: "html"`) at the scene's own length.

For a **whole film** — a story and its shots with the user's copy and pictures, a scenario card on the board, a voice-over, sound design and a render; with a GLEA delivery the film finished in a Video Editor project (a tutorial's interface as HTML scene clips, other films built with the editor's own layers) and rendered from it — use the `motion-film` workflow on the `greenlight` MCP server (SKILL.md (GreenLight Dash only)) instead of inserting scenes one by one.

The library is the app's own, at `$GL_MOTION_KIT_DIR` in every GLAI terminal (its engine and scenes; `registry.json` beside them lists every scene with its editable texts and photo slots). To make one scene's page yourself (here the `odometer` scene):

```bash
node -e "const fs=require('fs'),path=require('path'),vm=require('vm');const D=process.env.GL_MOTION_KIT_DIR,src=(f)=>fs.readFileSync(path.join(D,f),'utf8');globalThis.window=globalThis;const run=(f)=>{if(window.UIK)UIK.__loadingFile=f;vm.runInThisContext(src(f),{filename:f});};['easings.js','engine.js','catalog.js'].forEach(run);UIK.FILES.forEach(run);run('html-export.js');const el=UIK.elements.find((e)=>e.id==='odometer');console.log(UIK.toHTML(el,{theme:'light',sources:{easings:src('easings.js'),engine:src('engine.js'),files:[src(el.file)]}}));" > odometer.html
```

Then add the page as an html clip: write it into the board folder and pass its url as `htmlUrl`, or send its text as `html`, to `POST …/html-clips` (GreenLight Dash only).
