> **GreenLight Motion Engine:** this is the GreenLight Dash Video Editor's project format, which the engine reads as is.
> Ignore the `/api/...` routes and the app UI described here: in the engine you edit `project.json` and run
> `npx greenlight-motion build`. MotionFast templates (`mediaType: "motion"`) stay in GreenLight Dash.

# GreenLight Dash — Video projects and timeline basics

> Part of the greenlight-dash skill. Read this shared contract before editing a timeline, then only the relevant topic below. Do not load every video reference.

## Task routing

| Task | Reference |
| --- | --- |
| Full export, render jobs, still frames, AI Fill | [video-rendering.md](video-rendering.md) |
| AI Reframe / Beats / Sound Design, saved analysis, speed curves and smoothing | [video-analysis.md](video-analysis.md) |
| Keyframe tracks, easing, custom expressions | [video-keyframes.md](video-keyframes.md) |
| Object motion paths, point reduction, text on path, motion follow | [video-paths.md](video-paths.md) |
| Cross transitions, layer entrances/exits, Custom lanes | [video-transitions.md](video-transitions.md) |
| Text, captions, reveal presets, background-bar animations | [video-text.md](video-text.md) |
| Background fills and GLSL shaders | [video-backgrounds.md](video-backgrounds.md) |
| Shape paths, strokes and vector provenance | [video-shapes.md](video-shapes.md) |
| Grid Builder layouts | [video-grid.md](video-grid.md) |
| Using MotionFast templates and device mockup clips | [video-motion.md](video-motion.md) |
| HTML pages as timeline layers (html clips) and their bakes | [video-html-clips.md](video-html-clips.md) |
| Overlay Effects and Layer Effects, including Running Glow and Depth | [video-effects.md](video-effects.md) |
| 3D models, Scene Rig, lighting and shadow plates | [video-3d.md](video-3d.md) |
| Camera layer, Camera Rig, camera paths and presets | [video-camera.md](video-camera.md) |
| Particles, packing, proximity, fluid and smoke | [video-particles.md](video-particles.md) |
| Writing motion tracks, roto masks or solved cameras | [tracking-data.md](tracking-data.md) |
| You are making one version of a project for Variants (your copy, the scope, `ready`) | [video-variants.md](video-variants.md) |
| AI Viral Edits (kinetic words around a layer's subject) and sequences with an Essential panel (`clip.essential`) | the `viral-edits` workflow on the `greenlight` MCP server ([SKILL.md](../SKILL.md#ai-workflows-the-greenlight-mcp-server)); `essential` below |

In this file: Editing and verification · Text animation pace · Video Projects (list, get, card, create, update, collaborative boards, refresh revision, activate, delete, build from clips) · Editor `data` shape · Sequence clips · Video presets (and project export / import bundles, GreenLight Motion pages) · Interface scenes.

Use `GET /api/video-editor/capabilities` for the installed build's effect and transition ids, fields, ranges and render support. Read the relevant subtree instead of copying a catalog into the prompt. For custom MotionFast authoring, use [the authoring skill](../../motionfast-templates/SKILL.md).

## Editing and verification

1. GET the project and retain its top-level `version` separately from `data.version` (the editor schema version).
2. Modify only the requested fields, preserving unrelated clips, channels, items, assets and metadata. Keep every simultaneously visible layer on its own channel.
3. PUT the full updated `data` with `expected_version` from that GET. Resolve a 409 by fetching and reapplying the intended edit; never force a stale snapshot through.
4. GET again to verify the saved structure. For visible changes, use a composited still or a short full render from [video-rendering.md](video-rendering.md) to check the result: a successful save alone does not prove an effect or track renders.
5. Keep all media used by the project, including nested sequences and effect assets, even when it has no canvas card. Follow [media cleanup](media.md#clean-up-helper--intermediate-media-do-this-at-the-end-of-a-task).

## Text animation pace

By default, text that animates in, animates out or gets a one-time pass (a sweep, a highlight, a typed line) takes **at least 0.8–1 s**, counted from the moment its first unit starts to the moment its last unit settles. Faster than that, the words flash past before anyone can read them. The rule holds however the motion is built:

- **Advanced Animations on Time** (`textAnimators[].range.drive: "time"`): the span is `(units − 1) × stagger + duration`. For example, 4 words with `stagger` 0.06 and `duration` 0.8 take 0.98 s. For moves (rise, slide, scale, rotate, blur), reach the span with `duration`, because a long `stagger` makes a long line crawl. A typewriter (`duration` 0) gets its pace from `stagger`.
- **Keyframes** (`txa:` range tracks such as Start or Offset, or a text layer's own position, scale and opacity tracks): the first and last key of one move sit at least 0.8 s apart. Key positions are % of the layer, so a move from `p1` to `p2` lasts `(p2 − p1) / 100 × layer seconds`.
- **Layer entrances and exits** on a text layer: `transitionInDuration` / `transitionOutDuration` of 0.8 or more.
- **Recipes** from [video-text-kinetic.md](video-text-kinetic.md) and [video-text-presets.md](video-text-presets.md) keep their tuned timing. On very short text (one or two words), where the span works out under 0.8 s, raise `duration` until it reaches 0.8 s.

Go faster only when the edit really needs it: the user asks for snappy or fast text, a word hits on a beat or a fast cut, a glitch or scramble flicks, the layer is too short to fit a 0.8 s move, or the animator uses `drive: "voice"` (the speech sets the pace there).

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

The project without its payload, plus its board's name: what a `video-project` canvas card shows ([elements.md](elements.md#video-editor-project-cards-a-video-project-on-any-board)). Use it to check that a board/project pair exists before making a card.

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
    user's screen. With GLEA attached the editor flushes every ~5s, so in that
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
{ "project_id?": "..." }
```

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

Video-editor `mediaType` values include `video`, `image`, `audio`, `text`, `shape`, `adjustment`, `sequence` (compound clip — see [Sequence clips](#sequence-clips-mediatype-sequence)), `grid` (Grid Builder — a container that lays its members out by a rule; see [video-grid.md](video-grid.md)), `motion` (native MotionFast animated template — see [video-motion.md](video-motion.md)), `model3d` (a live 3D model rendered in its own pass — see [video-3d.md](video-3d.md); its clip `url` must be a `model-preset:` or `model-primitive:` sentinel or a real asset URL, **never empty**), `particles` (a seeded particle simulation in a Solver Box, filmed by the project camera — see [video-particles.md](video-particles.md); the whole system lives on the ITEM as `particleSystem`), `camera` (virtual camera over the whole stack — see [video-camera.md](video-camera.md)), and `null` (a transform with no picture, never drawn in any render: the parent other layers hang off — see [Layer parenting and null layers](video-keyframes.md#layer-parenting-and-null-layers-keyframeparenting); clip `url` is `""`; item `nullColor` (default `#ff3b30`) and `nullSize` (marker diameter in composition px, 2–2000, default 24) style only the editor's preview marker). The fast `/render` only accepts `video` and `image`; **`/render-onserver`** (full headless render) bakes in the richer timeline types — `text`, `shape`, `sequence`, `audio`, `motion`, `model3d`, `particles`, keyframes, filters — exactly like the desktop editor. A **device mockup** is not its own `mediaType` — it is a rendered `video` clip that optionally carries a `mockupConfig` for re-editing (see [video-motion.md](video-motion.md)).

If you need to build the editor state by hand instead of using `/from-clips`, the canonical schema is the `sanitizeClip` / `sanitizeTimelineItem` / `buildPersistedState` functions in `frontend/src/components/videoEditor/VideoEditor.jsx`. Minimum viable shape:

```json
{
  "version": 3,
  "videoSize": { "w": 1920, "h": 1080 },
  "motionBlurEnabled": false,
  "clips": [{ "id", "source": "REMOTE", "mediaType": "video", "url", "name", "duration", "proxyUrl?", "thumbnailUrl?", "previewOriginal?" }],
  "channels": [{ "id", "name": "Channel 1", "visible": true, "items": [{ "id", "clipId", "transition", "transitionDuration", "transitionEasing", "transitionOrder?", "trimStart", "trimEnd", /* + the other sanitized fields */ }] }],
  "activeChannelId": "<id of the channel>",
  "selectedTimelineId": null,
  "currentTime": 0
}
```

**Preview source.** `"previewOriginal": true` on a clip makes the editor preview play the full-res original instead of its `proxyUrl` — sharper when scale/crop keyframes zoom in, at a heavier decode cost. Preview-only: every render path already uses the original.

**Layer scale is three fields.** `zoom` is the uniform scale (0.1–20, default 1), and `scaleX` / `scaleY` (same range, both default 1) are per-axis multipliers on top of it — so a layer's drawn width is `zoom × scaleX` and its height `zoom × scaleY`. Use `zoom` alone for an ordinary resize; reach for the other two only to stretch or squash one axis (a wide title bar, a squash-and-stretch bounce). All three are the panel's Transform → Scale row (X / Y / XY) and all three inherit through layer parenting. Every one of them also has a keyframe track (`scale`, `scaleX`, `scaleY` — see [video-keyframes.md](video-keyframes.md)), which multiplies the base field rather than replacing it. Projects written before these existed load unchanged: a missing `scaleX`/`scaleY` is 1.

**Layer grade — the static `filter*` fields.** Every visual item carries a CSS-style grade applied to the layer before it composites: `filterBlur` (px, 0–10, default 0), `filterBrightness` / `filterContrast` / `filterSaturation` (%, 0–200, default 100), `filterHueRotate` (deg, 0–360, default 0), `filterGrayscale` / `filterSepia` / `filterInvert` (%, 0–100, default 0; Invert at 100 is a full negative). These are the layer's own base values; the matching keyframe tracks (`blur`, `brightness`, `contrast`, `hue-rotate`, `saturate`, `grayscale`, `sepia`, `invert`) **override** the static field while the track exists rather than multiplying it, so key one or set the other, not both. They are a cheap per-layer grade and independent of the Overlay Effects chain — reach for `effects[]` when you need a real grade (curves, LUT, colour balance).

**Blend mode.** `blendMode` is any Photoshop mode, by camelCase id: `"normal"` (default), `"dissolve"`; `"darken"`, `"multiply"`, `"colorBurn"`, `"linearBurn"`, `"darkerColor"`; `"lighten"`, `"screen"`, `"colorDodge"`, `"add"` (Linear Dodge), `"lighterColor"`; `"overlay"`, `"softLight"`, `"hardLight"`, `"vividLight"`, `"linearLight"`, `"pinLight"`, `"hardMix"`; `"difference"`, `"exclusion"`, `"subtract"`, `"divide"`; `"hue"`, `"saturation"`, `"color"`, `"luminosity"`. `opacity` works with all of them. Two implementations, same result in preview and every render path: `multiply` / `screen` / `add` / `lighten` / `darken` are GPU hardware blends with no extra pass (the source is faded toward the mode's neutral colour first; exact for multiply/screen/add, monotonic approximations for lighten/darken), and every other mode reads the layers below in a shader, which routes the layer through the compositor's isolate branch — one extra full-frame pass per such layer, so prefer the hardware five where they give the look you want on a heavy project. A shader-mode layer composites flat: inside a real-3D frame it does not depth-test against other layers for that frame. Text layers ignore the hardware five (they composite Normal) but take every shader mode. The old caveat — `multiply` / `darken` painting a layer's own footprint black when it also carried a `layerEffects` entry — is fixed: the isolate is now drawn with the hardware blend suspended and the mode is applied when the plate meets the stack.

**Mirror.** `mirrorH` / `mirrorV` (booleans, default false) flip the layer's picture on its own axes, after scale and before rotation. Not the same as a negative scale — they never change the layer box, so framing, masks and child layers are unaffected.

**Layer titles.** Optional `"customName"` on any timeline item — the display title drawn on the clip in the timeline (and in the inspector's selected-layer header) in place of the clip/media name. Trimmed string, max 120 chars; empty or missing falls back to the default (the clip's `name`, or the text content for text layers). Set it whenever you build or edit a timeline so layers are self-describing — `"Intro logo"`, `"CTA caption"`, `"BG loop"` — instead of raw filenames; users can also rename in-app via the pencil beside the selected-layer title in the inspector panel. Display-only: no render path reads it.

**Videos and photos draw at their real size.** A `video` clip (like a bitmap `image`) keeps its own aspect ratio and never gets bars: larger than the composition, it is shrunk to fit; smaller than the composition on both axes, it keeps its pixel size. A 1280×720 clip in a 1920×1080 project covers 1280×720 at `zoom: 1` (set `zoom: 1.5` to fill the frame), and a 1080×1920 clip in a 16:9 project is a centred portrait picture. Whatever the picture does not cover shows the layers below, or the project background.

**Fit screen.** To make a video or image layer's whole picture fit the frame, call `POST /api/moodboards/{board_id}/video-projects/{project_id}/fit-screen` with `{"itemId": "<item id>"}` (the item can be inside a sequence) — the editor's **Fit screen** command (⌘K). It reads the media's real size on the server and saves the project: `zoom` becomes the fitting Scale (`max(1, min(compW/mediaW, compH/mediaH))` for a video or photo, `min(compW/w, compH/h)` of the declared size for an SVG), `scaleX`/`scaleY` become 1 and `panX`/`panY` 0. Rotation and keyframes are kept; `scale` keyframes multiply the new `zoom`. Answer: `{itemId, zoom, mediaWidth, mediaHeight, frame, version}`. 400 for a layer that is not a video or image, 422 when the media size cannot be read.

**SVG clips are vector layers.** An `mediaType: "image"` clip whose `url` ends in `.svg` (or is an `image/svg+xml` data url) is **not** letterbox-fitted to the frame like a bitmap: it is laid out at the size the document itself declares (`width`/`height`, else the `viewBox`, else 300×150 by CSS default sizing) and re-rasterized at whatever resolution it ends up covering, so it stays sharp under any `zoom` or camera push-in. Consequences when authoring: a 200×80 logo occupies 200×80 composition px at `zoom: 1` — set `zoom` (or scale keyframes) to size it, never assume it fills the frame; artwork larger than the composition overflows it. Everything else is an ordinary image clip (filters, transitions, effects, keyframes). An SVG loaded this way cannot reach external resources — fonts must be outlined and images embedded, the same restriction any `<img>`\-loaded SVG has.

**Animated image clips (GIF, animated WebP, APNG).** An `mediaType: "image"` clip whose `url` is an animated GIF, animated WebP or APNG plays as a moving picture instead of freezing on its first frame. Which frame shows is a pure function of the item's clip-local time, so preview and every render agree, and it is resolved from the file's own per-frame delays rather than an assumed frame rate — a file built around one long hold frame plays at the rate it was authored at. Two optional fields on the **item** control playback: `"gifLoopMode"` — `"loop"` (default, restart at the end), `"hold"` (freeze on the last frame) or `"pingpong"` (forwards then backwards) — and `"gifSpeed"`, a playback multiplier from 0.1 to 10, default 1, which changes only how fast the animation runs inside the clip and never the clip's length on the timeline. Both are dropped from the persisted JSON at their defaults, and a value outside those ranges is clamped on load. Set the clip `duration` (and the item's `trimEnd`) to the file's loop length for exactly one play-through — a longer span loops, a shorter one cuts — and `trimStart` offsets where the animation starts. Everything else is an ordinary image clip: plate sizing, filters, transitions, masks, effects and keyframes are unchanged, and still images are unaffected. **`/render-onserver` and `/render-still` bake the animation; the fast `/render` cannot ingest an animated file at all** (its ffmpeg image input assumes a still and errors on one), so send any timeline holding one to `/render-onserver`.

**Timeline markers.** Optional `"markers": []` at the `data` root — annotations on moments in the timeline (beat points, section starts, review notes). Each marker is `{ "id": "<unique string>", "time": <seconds ≥ 0>, "color": "#rrggbb", "name": "<label, ≤120 chars>" }`. `time` is absolute timeline seconds (a marker past the last clip is legal and kept). `color` must be a hex string; the palette is the 20 canvas label presets (`#ef4444 #f97316 #f59e0b #eab308 #84cc16 #22c55e #10b981 #14b8a6 #06b6d4 #0ea5e9 #3b82f6 #6366f1 #8b5cf6 #a855f7 #d946ef #ec4899 #f43f5e #78716c #6b7280 #94a3b8`), default `#8b5cf6` — other hex values load fine but won't match a palette swatch. `name` may be empty. Read/create/move/recolor/rename/delete them by editing this array and `PUT`ting `data` back; invalid entries (missing/negative `time`, non-hex `color`) are dropped on load and duplicate `id`s are de-duplicated (`sanitizeMarkers` in `VideoEditor.jsx`). The array is omitted from the persisted JSON when empty. Annotations only — every render path ignores them.

**Layer markers.** Optional `"layerMarkers": []` at the `data` root — the same pin attached to one **clip** instead of to the whole project ("the logo lands here", "cut this shot on this frame"). Each entry is `{ "id": "<unique string>", "itemId": "<an existing timeline item id>", "position": <0–100>, "color": "#rrggbb", "name": "<label, ≤120 chars>" }`. `position` is a percentage offset **inside that item**, the same coordinate `propertyKeyframes` use — **not** timeline seconds. Nothing stores an absolute time; it is derived from the item's current placement, which is why a marker travels with its clip when the clip is moved, trimmed or re-timed. To place one at timeline second `t` on item `i`, compute `position = (t - i.startTime) / i.duration * 100` from the channel layout. Same palette, default colour `#14b8a6`. Sanitized by `sanitizeLayerMarkers` in `VideoEditor.jsx`: entries with a missing/blank `itemId` or a non-numeric `position` are dropped, as are entries whose `itemId` no longer matches a live item (a deleted clip or layer takes its markers with it). The array is omitted from the persisted JSON when empty, and like `markers` it is ignored by every render path.

**Design tokens (project colour palette).** Optional `"colorTokens": []` at the `data` root — the handful of colours this project reuses (brand, accent, caption bar). Each entry is a **colour string**: `#rgb`, `#rrggbb`, `#rrggbbaa`, or `rgb()`/`rgba()`. Max 24; entries that don't parse are dropped on load and the array is omitted from the persisted JSON when empty (`sanitizeColorTokens` in `frontend/src/components/colorTokens.js`). Duplicates are kept as written. Purely an authoring palette — the editor shows them as the first row of swatches in every colour picker, and **no render path reads them**: a token is not a reference, so setting `colorTokens` does not retint anything on its own.

Agent rules: when the user asks for "the project's colours", "brand colours" or a palette, read `data.colorTokens` and **copy the literal values** into the fields you are setting (`textColor`, `shapeFillColor`, `background.solidColor`, animator colours (`textAnimators[].effects[].color`), effect colour params, …). When you introduce a colour the project will reuse, append it to `colorTokens` so it shows up in the user's pickers. Rewriting a token does **not** recolour layers that already used its value — change those fields too.

```json
{ "colorTokens": ["#8b5cf6", "#0ea5e9", "rgba(0, 0, 0, 0.6)"] }
```

**Project background.** Set `"background": { …backgroundConfig… }` at the `data` root to fill the stage behind every channel — a solid colour, gradient, GLSL shader, pattern, or image. It takes the same `backgroundConfig` object as shape backgrounds; the full schema, the gradient/shader preset ids, and the shader authoring rules live in the **Backgrounds (project & shape)** section below. Omit it (or use `"type": "transparent"`) for a transparent stage. Baked by **`/render-onserver`**; the fast `/render` ignores it. A bare colour string (`"background": "#3366cc"`) is coerced to `{"type": "solid", "solidColor": …}`; prefer the explicit object.

**One live item per channel.** Treat every channel as one timeline track, not as a container of simultaneously composited layers. At any timeline time, a channel may have at most one active item. If two items' visible windows overlap, only one is guaranteed to render (the later-starting item commonly wins) and the save API does not reject the project. For an unsnapped item, its ordinary visible window is `[freeStart, freeStart + (trimEnd - trimStart))`; validate these windows before `PUT`. Put every simultaneously visible image, shape, text block, motion layer, or other visual on a separate channel. This rule also applies inside sequence timelines. Reuse one channel for consecutive, non-overlapping captions or shots only.

**Keep unsnapped items sorted by `freeStart`.** On an `unsnapped` channel the editor treats the item BEFORE a clip in the `items` array as "the clip before it" — cross transitions, the seam button and the layout's overlap all read array neighbours, not time neighbours. The editor re-sorts on every insert, move and paste; an API write does not. After adding or moving items, sort each unsnapped channel's `items` by `freeStart` before `PUT`. An out-of-order array looks fine until the user adds a cross transition: the clip is then snapped against the wrong neighbour and jumps elsewhere on the timeline (e.g. past the end), so it appears to vanish.

**Motion blur (render-only).** Set `"motionBlurEnabled": true` at the `data` root — a project-wide switch, not per layer — to bake cinematic motion blur into full renders. Frames whose motion comes from **keyframed transforms** (incl. camera-layer moves and adjustment-layer pan/zoom) or **speed-ramped video** are rendered as a multi-sample shutter accumulation; still frames are untouched, so cost only grows where motion exists.

**Strength** is `"motionBlurShutter"` — a **shutter angle in degrees** alongside `motionBlurEnabled`. Only these four values are meaningful; anything else (missing, non-numeric, an off-table angle) snaps to the nearest level, so `180` is the effective default:

| Angle | Level | Samples | Cost on moving frames |
| --- | --- | --- | --- |
| `90` | Subtle | 8 | ~8× |
| `180` | Normal — cinematic default | 16 | ~16× |
| `270` | Strong | 24 | ~24× |
| `360` | Max | 32 | ~32× |

The angle is how much of each frame interval the exposure covers, so wider = more blur *and* proportionally slower. The field is only written when blur is on, so projects that never enabled it round-trip unchanged. Table lives in `frontend/src/components/videoEditor/motionBlurLevels.js`. Honored by **`/render-onserver`**, **`/render-onserver-job`** and the desktop Download/Render — **ignored by the fast `/render`** and never applied in the editor preview (render-only by design). Worth enabling for projects with fast zooms/pans that would otherwise strobe. Motion inside `sequence` clips counts too (a sequence's own camera clip, its layers' keys, speed ramps and live HTML), down to the 4-level nesting limit; parenting links inside a sequence are not read. Renders get proportionally slower on moving segments (~16× per moving frame).

**Renderer.** Every project renders on the engine the app is set to — one app-wide setting, not a project field. Read it with `GET /api/video-editor/engine` (`engine`: `"webgl"`, the default, or `"webgpu"`). Preview and the desktop Download use it; the headless renders (`/render-onserver`, `/render-onserver-job`, `/render-still`) take it as the request's `"renderer"` field, which defaults to `"webgl"`, so pass the engine there to render what the editor shows. It matters wherever shading is written by hand rather than picked from a list: an uploaded Advanced Transition package is authored for one engine and is refused on the other, and a **custom** adjustment/layer effect (`"id": "custom"`) cannot run on WebGPU at all — its body is compiled at runtime, so the effect is skipped with a reason. Building a new template or transition: [custom-builds.md](custom-builds.md).

**Sound & audio fades.** Clips with audio (`video` and `audio` media types) honor per-item `volume` (0–100 %, default 100; 0 also writes `muted: true`) and an intro/outro fade: `audioFadeIn` / `audioFadeOut` (seconds of the item's **placed** span; 0/absent = off; only stored when > 0) plus one `audioFadeCurve` for both ends (`"linear" | "smooth" | "exponential"`; only stored when it differs from the `"smooth"` default). The envelope multiplies onto `volume`; on a clip shorter than its two fades they overlap and multiply into a bump that never reaches full level. Fades span the item's placed bounds, so a partial (`rangeStart`/`rangeEnd`) render keeps the same shape. Applied identically in preview and the WebCodecs export paths (desktop Download and `/render-onserver`); the fast `/render` ignores dedicated audio clips entirely.

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
- Prefer `"unsnapped": true` + `freeStart` on inner channels — that's what the editor's own "Group as sequence" produces.
- The parent timeline item referencing the sequence clip is a **normal item** (`{ "id", "clipId": "seq1", "trimStart": 0, "trimEnd": 6, ... }`) — trim it to show only part of the sequence, add keyframes/filters/transitions to affect the whole block.
- **A sequence with `essential`** is a built edit that carries its own recipe. There are two kinds:
  - **An AI Viral Edit:** `"essential": { "kind": "viral-edit", "v": 3, "recipe": { "settings", "analysisUrl" (or "analysis"), "cutoutUrl", "sourceUrl", "itemId", "editId", "W", "H", "fps", "at", "timeOffset", "duration" } }` (older edits carry `"v": 1` or `2`; a rebuild turns them into v3).
    - The editor rebuilds the layers inside the sequence from the recipe whenever the user changes one of its settings. A rebuild replaces any hand edits made inside the sequence.
    - To change such an edit, rebuild it with the `viral-edits` workflow (its build step rebuilds in place). Edit its inner layers by hand only for a one-word change the user asked for.
  - **A HyperFrames scene** (made by Convert to scenes): `"essential": { "kind": "hyperframes-scene", "v": 1, "recipe": { "url", "sceneId", "label", "clipValues", "compositionVariables", "sceneVariables", "sceneDefaults", "values", "sceneValues" } }`.
    - Its Essential panel sets per-scene values. A change rewrites only the `gl-vars` of the html pages inside the sequence; the layers, keys and camera stay.
    - To change the values, call `…/html-clips/{item_id}/hyperframes-scene-values` ([hyperframes.md](hyperframes.md#per-scene-values-after-convert-to-scenes)). Do not edit the pages' urls by hand.
  - When you write the project, keep `essential` exactly as it is. Without it, the edit can no longer be rebuilt.
  - The editor drops an `essential` sequence clip from `clips` once no item uses it.
- **Rendering:** `/render-onserver` bakes sequences in fully; the fast `/render` rejects them with 400. Adjustment layers inside a sequence composite (grade + effects chain + layer mask alike). Known nested limits: the project's global Depth of Field doesn't composite inside a sequence (a sequence's own camera clip's depth of field does: AI Viral Edits use it), and inner audio only exports when the sequence item plays at flat 1× speed.
- Keep ids unique across the whole document, inner timelines included.

### Video presets (save & load reusable sequences)

Presets are **global** (not per-board) JSON files under `media/video-presets/` — one file per preset. Format:

```json
{ "version": 1, "kind": "ve-sequence-preset", "name": "Lower third", "duration": 4.0,
  "videoSize": { "w": 1920, "h": 1080 },
  "sequence": { "clips": [ ... ], "channels": [ ... ] } }
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
- Video PROJECTS have the same bundle endpoints: `GET /api/moodboards/{board_id}/video-projects/{project_id}/export` (zip with `project.json` + media) and `POST /api/moodboards/{board_id}/video-projects/import` (multipart `file` = that zip, or a bare editor-state .json) which creates a NEW project in the board with media imported and URLs remapped.

### GreenLight Motion pages (Export for agents)

A project leaves the app through Video Editor ▸ project chip ▸ **Export for agents**, as ONE of:
- **a `.glvideo` file** (the window's default, `format: "glvideo"`): the project in one file, for a Claude chat (drop it
  on the GreenLight Motion connector's video page) or another GreenLight Dash (double-click). Layout below.
- **a GreenLight Motion Engine page** (`format: "folder"`, the API's default): a folder with `index.html` (plays the
  project in Chrome/Edge from a double-click, nothing to install: the studio — preview, layers, options, Notes,
  Render MP4), `project.json` (the editor `data` above + `name`, `formatVersion: 1` and `template` — the options), and
  `assets/` (`assets/media/<rel>` = the board's `/media/<rel>` files under their original refs, `assets/hdr/`,
  `assets/models/`). For an agent on this computer that works on `project.json`.

Over the API:

```
GET  /api/moodboards/{board_id}/video-projects/{project_id}/light-report
     → { name, template | null, leftOut: [{ kind, reason, layers[] }], engine: bool, defaultDest }
POST /api/moodboards/{board_id}/video-projects/{project_id}/export-light
     { "dest?": "/abs/parent/folder", "title?": "…", "template?": { "title", "fields": [ … ] },
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

- `template.fields[]` = `{ key, label, type: text|color|image|number|select|toggle, targets: [{ itemId | clipId | (neither = project), path }] }`
  — e.g. `{ "key": "headline", "label": "Headline", "type": "text", "targets": [{ "itemId": "<item id>", "path": "textContent" }] }`,
  a shape colour `path: "shapeFillColor"`, the background `{ "path": "background.solidColor" }`. Omit `template` to keep
  the project's saved one; `pack: true` (folder only) also writes one self-contained `.html` next to the folder (for a
  Claude artifact: keep it under 16 MB). `smaller: true` puts WAV sounds in as MP3 and PNG pictures as WebP (transparency
  kept) and points the exported project at them — the board keeps its originals; `smaller` in the answer is
  `{ sounds, pictures, before, after }`. A name already taken gets a number: `<title> 2.glvideo`, `<title> 2/`.
- The template is kept beside the project (`<board folder>/.motion/<project id>.template.json`), not in its `data`.
- `import-light` copies every file into the board (`motion-<title>/`), except a `/media/` file this machine already
  has byte for byte; the template comes back too. It is what the page's **Open in GreenLight Dash** button does
  (`greenlightdash://open?path=…`, handled by the desktop app on the board that is open).
- `leftOut` names layers the page does not play (MotionFast templates, After Effects clips) — they stay in the data.
- The one-shot `GET .../export` answers only after the whole zip is written — minutes for a project with gigabytes of media, with no way to see progress or stop it. For big projects start a job instead: `POST /api/moodboards/{board_id}/video-projects/{project_id}/export-job` returns at once with `{id, status, phase, progress, filesDone, filesTotal, bytesDone, bytesTotal, currentFile, missing, filename, downloadUrl}` (a project that is already exporting returns its running job). Poll `GET /api/video-project-export-jobs/{id}` until `status` is `completed`, `failed` or `cancelled`, then `GET` its `downloadUrl`; `missing` counts referenced media files that are gone from disk and were left out. `DELETE /api/video-project-export-jobs/{id}` cancels a running job or deletes a finished one's zip; a zip nobody deletes expires after an hour.

### Interface scenes (built-in animated scenes — "the UI kit")

The editor's **Presets** tab also lists the **Interface scenes** library (called GL Motion before 14.0.25): 275 ready-made animated scenes (controls, cards, charts, checkout, coupons, countdowns, galleries…) in one style, all transparent (they sit over the video). Search and category chips filter them; Light / Dark and an accent recolour them. A card's **HTML clip** button inserts the scene as one standalone transparent HTML page, saved into the board's media (`ui-kit/<id>.html`) and placed as an HTML clip (`mediaType: "html"`) at the scene's own length.

For a **whole film** — a story and its shots with the user's copy and pictures, a scenario card on the board, a voice-over, sound design and a render; with a GLEA delivery the film finished in a Video Editor project (a tutorial's interface as HTML scene clips, other films built with the editor's own layers) and rendered from it — use the `motion-film` workflow on the `greenlight` MCP server ([SKILL.md](../SKILL.md#ai-workflows-the-greenlight-mcp-server)) instead of inserting scenes one by one.

The library is the app's own, at `$GL_MOTION_KIT_DIR` in GLAI and GLEA terminals (its engine and scenes; `registry.json` beside them lists every scene with its editable texts and photo slots). To make one scene's page without the UI: `node -e "const fs=require('fs'),path=require('path'),vm=require('vm');const D=process.env.GL_MOTION_KIT_DIR,src=(f)=>fs.readFileSync(path.join(D,f),'utf8');globalThis.window=globalThis;const run=(f)=>{if(window.UIK)UIK.__loadingFile=f;vm.runInThisContext(src(f),{filename:f});};['easings.js','engine.js','catalog.js'].forEach(run);UIK.FILES.forEach(run);run('html-export.js');const el=UIK.elements.find((e)=>e.id==='odometer');console.log(UIK.toHTML(el,{theme:'light',sources:{easings:src('easings.js'),engine:src('engine.js'),files:[src(el.file)]}}));" > odometer.html`, then upload it and place it as an HTML clip.
