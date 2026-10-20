> **GreenLight Motion Engine:** this is the GreenLight Dash Video Editor's project format, which the engine reads as is.
> Ignore the `/api/...` routes and the app UI described here: in the engine you edit `project.json` and run
> `npx greenlight-motion build`. MotionFast templates (`mediaType: "motion"`) stay in GreenLight Dash.

# GreenLight Dash — Motion paths, text on path and motion follow

> Read [video-projects.md](video-projects.md) for the shared project, clip, channel, timing and versioned-write contracts. Load only the sections needed for the task.

## Contents

- [Object Motion Paths (`motionPath` + `motionPathT`)](video-paths.md#object-motion-paths-motionpath--motionpatht)
- [Motion-track follow (`motionTracks` + `motionFollow`)](video-paths.md#motion-track-follow-motiontracks--motionfollow)

### Object Motion Paths (`motionPath` + `motionPathT`)

Any ordinary visual timeline item can follow a saved 3D bezier path. The path is stored on the **item**, not the clip. Points use world pixels: origin at the composition centre, `x` right, `y` up, and `z` toward the viewer. `hIn`/`hOut` are tangent **offsets from their own anchor**, not absolute control-point coordinates: the segment A→B is the cubic `A → A+A.hOut → B+B.hIn → B`. ⚠️ **Write the handles.** A missing or zero-length handle is a **corner** — nothing derives a tangent for you, because the auto-smoothing pass runs only when a human adds or drags a point in the 3D world view, while load, save, preview, export and `/render-onserver` sample the stored handles verbatim. A path written as bare `x`/`y`/`z` points therefore flies **straight lines** between anchors (and can silently change shape later, the first time the world view is opened on it). Set `manual: true` on every anchor as well, so that pass leaves the curve alone. The smooth tangent to write is the editor's own Catmull-Rom one — `hOut = (P[next] − P[prev]) / 6`, `hIn = −hOut`, componentwise; on this open-by-default path the first anchor uses `(P[1] − P[0]) / 3` and the last `−(P[last] − P[last−1]) / 3`, and a `closed` path wraps instead. `GET /api/video-editor/capabilities` → `paths` restates this contract; world-space paths are unclamped.

```json
{
  "motionPath": {
    "points": [
      { "x": -520, "y": -120, "z": 0 },
      { "x": 0, "y": 180, "z": 120,
        "hIn": { "x": -180, "y": -40, "z": -20 },
        "hOut": { "x": 180, "y": 40, "z": 20 }, "manual": true,
        "rx": 15, "ry": 0, "rz": -30 },
      { "x": 520, "y": -80, "z": 0 }
    ],
    "closed": false,
    "follow": true,
    "aim": "tangent",
    "keyframesPerPoint": true,
    "keyframesPerPointCount": 3,
    "keyframesPerPointClosed": false
  },
  "motionPathT": 0,
  "propertyKeyframes": {
    "motionPathT": [
      { "position": 0, "value": "0", "easing": "Linear" },
      { "position": 50, "value": "50", "easing": "Linear" },
      { "position": 100, "value": "100", "easing": "Linear" }
    ]
  }
}
```

- A path is live only when it has at least two valid points and `follow: true`.
- `motionPathT` is 0–100. On an open path, 0 is the first anchor and 100 the last. On a closed path, 100 completes the loop back to the first anchor.
- `aim: "tangent"` aligns the layer's local +X axis with the curve; `aim: "points"` orients the layer from the anchor rotations alone (below); `aim: "free"` preserves its ordinary rotation/keyframes.
- Anchors may carry a per-point rotation `rx`/`ry`/`rz` (degrees, same sign convention as the layer Rotate fields; omit when all zero — the sanitizer strips all-zero triples), blending linearly between anchors over each segment so the layer banks/tilts/spins into a rotated point as it travels. With `aim: "tangent"` it is applied **in the aimed local frame** on top of the tangent aim; with `aim: "points"` the blended anchor rotation drives orientation by itself on world axes — no tangent alignment — falling back to Free behaviour while no anchor is rotated.
- While Follow Path is live, the path owns local X/Y/Z position. Turn `follow` off before editing `translateX/Y/Z` as the visible position authority. Scale remains independent; Free aim also leaves rotation independent.
- **Offset from path** — `motionPathOffsetX`/`Y`/`Z` on the item, px, panel signs (+X right, +Y **down**, +Z toward the viewer). A constant displacement from the sampled curve, applied on **world axes** (it does not swing with the tangent), so several layers can share one path and hold a formation. It moves the rider, never the curve: the aim, the drawn overlay and the anchors are unchanged. No-op while `follow` is false. Each axis is a keyframable track of the same name.
- **Copying a curve between layers**: motion paths and camera paths share this world-pixel space, so `points`/`closed` can be assigned across them literally. A shape outline must be converted from its unit box through the source shape's own Width/Height, `zoom` and Position to land where the shape is drawn — `collectPathSources`/`cloneWorldPoints` in `frontend/src/components/videoEditor/pathCopy.js` do that conversion.
- `keyframesPerPoint*` is bookkeeping for the "one key per anchor" convenience: one evenly-spaced `motionPathT` key per anchor, a closed path adding the final 100 key back to anchor one. Omit it and author any valid progress track directly.
- The normal preview, 3D view, WebCodecs export, and `/render-onserver` all evaluate the same curve.
- **To draw the curve as a visible trail**, add a `line` shape layer on its own channel below the rider: size it to the path's bounding box (`shapeSizeUnit: 'px'` + `shapeWidthPx`/`shapeHeightPx`) and pan it onto that box's centre so the outline lands where the path runs. Set `panZ` to the path's mid-depth plus the layer's `motionPathOffsetZ` **minus 2** — coplanar with the layer riding it, the two planes intersect under any camera move. `shapeOutlineFromMotionPath` in `frontend/src/components/videoEditor/shapePath.js` does the world-pixel → unit-box conversion (a closed path comes back open with its first anchor repeated, because a Line is open by definition). It is a snapshot: the two are independent afterwards.
- **19 ready-made path shapes** ship as recipes in `frontend/src/components/videoEditor/objectMotionPathPresets.js` — travel paths (Arc, S-Curve, Corner, U-Turn, Wave, Zigzag, Bounce, Loop, Swing, Spring, Spiral In/Out) and closed loops (Circle, Orbit, Figure 8, Heart, Square, Triangle, Star), each centred on the composition and scaled to the frame. Read the exact point/handle values from there rather than approximating a shape by hand.

#### Smoothing / reducing any path — `POST /api/paths/smooth`

A traced, tracked or hand-drawn path arrives with far more anchors than anyone wants to fine-tune (a rotoscoped mask, a motion-tracker export, a 44-point spiral preset). This endpoint rewrites a point list with fewer, cleaner anchors, and it is the **same code the editor's "Smooth path" button runs**, so an agent-smoothed path is identical to a hand-smoothed one.

It is deliberately **stateless and path-agnostic** — every path in the app stores the same anchor shape, so read the points out of the project, post them here, and write the result back where you found them. Works for `item.motionPath.points`, `item.shapePath.points`, `item.cameraPath.points`, a layer mask's `path.points`, and any `shapePath`/`msk:<mid>:path` keyframe value.

```json
POST /api/paths/smooth
{
  "points": [ { "x": 0, "y": 0, "hIn": {...}, "hOut": {...} }, ... ],
  "closed": false,
  "mode": "fit",
  "amount": 34,
  "limit_points": true,
  "max_points": 24,
  "corner_deg": 34
}
```

Response: `{ "points": [...], "stats": { "before", "after", "removed", "corners", "maxDeviation", "maxDeviationPct", "meanDeviation", "lengthDeltaPct", "epsilon", "keptIndexes" } }`. The returned points are ready to assign straight back (handles as offsets, `manual: true`, `z` only when the input had it).

**Pick the mode by what must be preserved:**

| `mode` | What it does | Anchor count | Use when |
| --- | --- | --- | --- |
| `fit` (default) | Refits the curve with as few cubic segments as the tolerance allows | Chosen by the tolerance; anchors land in **new** places | The general "this has too many points" case |
| `reduce` | Deletes only the redundant anchors, refits the handles around them | Chosen by the tolerance; survivors keep their **exact** coordinates | Anchors carry per-point data (`rx`/`ry`/`rz`) or the path is keyframed |
| `even` | Rebuilds with exactly `even_count` anchors at equal arc length | Exactly `even_count` | A specific count is needed (e.g. to match another key) |
| `relax` | Averages out the shake, keeping every anchor | **Unchanged** | Tracked / hand-drawn paths whose count is fine but whose shape wobbles |

- `amount` (0–100) is the single tolerance knob; ~8 is a light tidy-up, ~48 is aggressive. Pass `epsilon` instead to set the tolerance directly in the path's own units. Tolerance is measured as a share of the path's bounding box, so the same `amount` behaves the same on a 1920px motion path and a ±0.5 unit-box mask.
- `corner_deg` (default 34) keeps turns sharper than that many degrees as **corners**. This is what lets a star stay a star: at the default a traced 10-point star refits to exactly 10 anchors with zero deviation, while `corner_deg: 180` (corner detection off) spends 20 anchors and is still less accurate. Raise it to deliberately round a spiky path off.
- Check `stats.maxDeviationPct` before writing the result back — under ~0.4% of the bounding box is visually identical, over ~1.5% is a visible shape change. `mode: "even"` with a small count can move the curve a long way; the number tells you so.
- **A keyframed path must keep the same point count in every key** — a shape morph, a mask path track and a one-key-per-anchor `motionPathT` track all pair point 3 of one key with point 3 of the next. So: smooth the key you can see with `mode: "reduce"`, then replay that exact reduction on every other key by posting each one with `{"points": <that key>, "kept_indexes": <stats.keptIndexes from the first call>}`. `mode: "even"` (same `even_count` for every key) and `mode: "relax"` are also safe. **`mode: "fit"` is not** — it picks its own count per key, so key 1 lands on 9 anchors, key 2 on 11, and the morph breaks.
- Changing the count of a motion/camera path invalidates a one-key-per-anchor progress track: rebuild `motionPathT` / `camPathT` with evenly spaced keys (see `keyframesPerPoint` above) or leave the plain 0→100 pair.
- Errors are HTTP 400: fewer than 3 points, more than 5000, an unknown `mode`, or a degenerate (zero-length) path.

#### Text on Path (`textPathEnabled`)

A **text** item with a motion path can lay its glyphs out along the curve instead of (or as well as) riding it. Fields (all on the item, sanitized defaults shown):

```json
{
  "textPathEnabled": true,
  "textPathGrain": "symbols",        // 'symbols' (letters) | 'words' — one pose per unit
  "textPathDirection": "center",     // 'center' (anchored mid-window, follows textAlign) | 'forward' | 'backward'
  "textPathTravel": "fit",           // where 100% leaves the run: 'fit' = its far end lands on the far point; 'through' = its leading unit does (text runs off)
  "textPathSpacingMode": "natural",  // 'natural' keeps measured advances; 'even' splits the trim window equally
  "textPathSpread": 100,             // % — multiplies advances (natural) / window share (even); 10–400
  "textPathSpacing": 0,              // extra arc px per unit gap; −200–500
  "textPathTrimStart": 0,            // % of curve length — usable window start
  "textPathTrimEnd": 100,            // % — window end
  "textPathOffsetY": 0,              // px perpendicular (baseline) offset; rows stack along the normal
  "textPathRotate": true             // align each unit with the curve tangent
}
```

- Placement is arc-length parameterised (kerning survives corners) and shares `evaluateObjectMotionPath`, so preview, WebCodecs export and `/render-onserver` agree.
- **Progress reuses `motionPathT` + its Path Progress track** and moves every glyph along the curve (not the block as one object). A closed untrimmed loop wraps like a marquee; an open or trimmed path extrapolates straight past its end tangents, so text can slide onto/off the curve. Keying `textPathTrimEnd` 0→100 is a write-on.
- `textPathDirection` decides where the run rests at 0% and which way progress carries it: `forward` parks the text ON the first point and travels to the last, `backward` ends it on the last point and travels back to the first, `center` (default) keeps the legacy middle anchor and follows `textAlign` (start/centre/end of the trimmed window). Multi-line text stacks rows along the curve normal at line-height steps.
- `textPathTravel` sets how far 100% carries a forward/backward run: `fit` (default) stops when the run's far end reaches the far point, so the whole text stays on the path; `through` keeps going until the leading unit gets there, sliding the text off the end. Travel is computed per row (each row's run has its own length), and a run longer than the trimmed window has nowhere to travel under `fit`. Ignored by `center` (which always slides the full window) and by a wrapping closed loop (always a whole lap).
- While `textPathEnabled` is live (path has ≥2 points), `follow` is ignored — the glyph run owns the curve and the layer's own transform stays put. The caption background bar (`textBgEnabled`) is suppressed on a path; split/in-out animations, highlight, randomizer and word timings all compose per unit on the curve.
- `follow` is NOT required: draw a path, leave `follow: false`, set `textPathEnabled: true`.

### Motion-track follow (`motionTracks` + `motionFollow`)

A video layer the user has motion-tracked in the editor carries the result on the item as `motionTracks: []` — each track `{ id, name, mode, refTime, region, sourceFps, sourceAspect, segments, samples }`, where `samples` rows are `[tSourceSeconds, cx, cy, scale, rotDeg, confidence]` in the clip's **source** seconds, normalised to the source frame (so a track survives trims, splits and speed changes). **The editor's own analysis has no endpoint** — it runs on decoded frames inside the app. Treat a track the USER made as read-only: preserve it verbatim when copying items, and never hand-edit its samples. An agent can, however, compute tracking data itself (OpenCV in Python) and write a NEW track into the project — the sample layout, the coordinate spaces and a worked recipe are in [tracking-data.md](tracking-data.md).

Tracks arrive from either of the editor's two analyses, and both land in the same array with the same shape: **Motion Tracking** (the user drew a box around one detail) and **Camera Tracking** (the whole frame is solved, the user picks tracking points off the result, and each null they create writes one track here). A camera-tracked null is an ordinary shape layer — a 20 px `ellipse` at `opacity: 0` — whose `motionFollow` pins it to its track, so nothing about following, rendering or copying is special-cased for it. There is nothing to distinguish the two kinds after the fact, and nothing that should be.

What an agent **can** do is attach any visual layer to an existing track — "make this text ride the car", "pin this badge to the player" — by writing `motionFollow` on the follower item:

```json
"motionFollow": {
  "itemId": "<id of the timeline item that owns the track — the follower's own id for a self-follow>",
  "trackId": "<a track id from that item's motionTracks>",
  "mode": "ride",
  "position": true,
  "scale": true,
  "rotation": true,
  "smoothing": 0
}
```

- `mode` — what the link does with the tracked motion. `"ride"` (default): keep the follower's own transform and **add** the motion to it. `"pin"`: put the follower **on** the tracked point, ignoring its own placement — right for a badge or arrow that should sit on the subject with nothing to line up. `"lock"`: cancel the motion so the tracked subject stands still and the footage moves under it (stabilisation) — only meaningful as a **self-follow** on the item that owns the track (`itemId` = the follower's own id); on any other layer it swings that layer around a distant pivot.
- **The offset rule (ride mode).** A track contributes zero motion at its `refTime`; wherever the follower's own transform puts it at that moment **is** the offset — there are no offset fields. So author the link in two steps: set `motionFollow`, then set the follower's position/keyframes so it sits where it should at the track's reference frame. `refTime` is in the source clip's seconds; the matching timeline moment is where the track-owning item plays that source second — its placed start plus `(refTime - trimStart)`, adjusted for any speed change on that item.
- `position` / `scale` / `rotation` — booleans choosing which motion components apply; omitted means `true`.
- `smoothing` — integer 0–30, ± that many source frames averaged; the knob that makes a jittery hand-held track usable without re-analysis.
- The source item should share screen time with the follower; the link is by item id + track id, not stack position. A dangling reference (deleted layer or track) is **kept and no-ops** — nothing errors, the follower just stops moving — so verify both ids exist when a follow seems dead.
- Applied identically in preview and every render path, including `/render-onserver`; gaps in the track (occlusions recorded in `segments`) are interpolated across.

* * *
