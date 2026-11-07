> **GreenLight Motion Engine:** this is the GreenLight Dash Video Editor's project format, which the engine reads as is.
> Ignore the `/api/...` routes and the app UI described here: in the engine you edit `project.json` (or `apply`) and run
> `npx greenlight-motion build`; what `GET /api/video-editor/capabilities` returns there is `npx greenlight-motion schema <topic>`
> here. `frontend/src/…` paths are files of the engine's public source repository. MotionFast templates (`mediaType: "motion"`)
> stay in GreenLight Dash.

# GreenLight Dash — Motion paths and text on path

> Read [video-projects.md](video-projects.md) for the shared project, clip, channel, timing and versioned-write contracts. Load only the sections needed for the task.

## Contents

- [Object Motion Paths (`motionPath` + `motionPathT`)](#object-motion-paths-motionpath--motionpatht)
  - [Ready-made path shapes](#ready-made-path-shapes)
  - [Smoothing / reducing any path — `POST /api/paths/smooth`](#smoothing--reducing-any-path--post-apipathssmooth)
  - [Text on Path (`textPathEnabled`)](#text-on-path-textpathenabled)
  - [Animated motion path (`motionPathPoints`)](#animated-motion-path-motionpathpoints)
- [Motion-track follow (`motionTracks` + `motionFollow`)](#motion-track-follow-motiontracks--motionfollow) — in tracking-data.md (GreenLight Dash only)

### Object Motion Paths (`motionPath` + `motionPathT`)

Any ordinary visual timeline item can follow a saved 3D bezier path. The path is stored on the **item**, not the clip. Points use world pixels: origin at the composition centre, `x` right, `y` up, and `z` toward the viewer; world-space paths are unclamped. `hIn`/`hOut` are tangent **offsets from their own anchor**, not absolute control points: the segment A→B is the cubic `A → A+A.hOut → B+B.hIn → B`.

**Write both handles and `manual: true` on every anchor.** A missing or zero-length handle is a corner, and nothing fills one in: load, save, preview, export and `/render-onserver` sample the stored handles verbatim, and the auto-smoothing pass runs only on a hand edit in the editor's 3D view. A path written as bare `x`/`y`/`z` points therefore flies straight lines between anchors, and can change shape the first time it is opened in that view. Compute smooth handles with the tangent rule in [Writing the handles](video-shapes.md#writing-the-handles) (also in `GET /api/video-editor/capabilities` → `paths.tangents`); in world space every handle also carries `z`.

```json
{
  "motionPath": {
    "points": [
      { "x": -520, "y": -120, "z": 0,
        "hIn": { "x": -173.3, "y": -100, "z": -40 },
        "hOut": { "x": 173.3, "y": 100, "z": 40 }, "manual": true },
      { "x": 0, "y": 180, "z": 120,
        "hIn": { "x": -180, "y": -40, "z": -20 },
        "hOut": { "x": 180, "y": 40, "z": 20 }, "manual": true,
        "rx": 15, "ry": 0, "rz": -30 },
      { "x": 520, "y": -80, "z": 0,
        "hIn": { "x": -173.3, "y": 86.7, "z": 40 },
        "hOut": { "x": 173.3, "y": -86.7, "z": -40 }, "manual": true }
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
- `motionPathT` is 0–100. On an open path, 0 is the first anchor and 100 the last. On a closed path, 100 completes the loop back to the first anchor. Progress tracks take `Linear` (constant speed); an eased progress crawls at both ends.
- `aim: "tangent"` aligns the layer's local +X axis with the curve; `aim: "points"` orients the layer from the anchor rotations alone (below); `aim: "free"` preserves its ordinary rotation/keyframes.
- Anchors may carry a per-point rotation `rx`/`ry`/`rz` (degrees, same sign convention as the layer Rotate fields; omit when all zero — the sanitizer strips all-zero triples), blending linearly between anchors over each segment so the layer banks/tilts/spins into a rotated point as it travels. With `aim: "tangent"` it is applied **in the aimed local frame** on top of the tangent aim; with `aim: "points"` the blended anchor rotation drives orientation by itself on world axes — no tangent alignment — falling back to Free behaviour while no anchor is rotated.
- While Follow Path is live, the path owns local X/Y/Z position. Turn `follow` off before editing `translateX/Y/Z` as the visible position authority. Scale remains independent; Free aim also leaves rotation independent.
- **Offset from path** — `motionPathOffsetX`/`Y`/`Z` on the item, px, with +X right, +Y **down**, +Z toward the viewer. A constant displacement from the sampled curve, applied on **world axes** (it does not swing with the tangent), so several layers can share one path and hold a formation. It moves the rider, never the curve: the aim, the drawn overlay and the anchors are unchanged. No-op while `follow` is false. Each axis is a keyframable track of the same name.
- **Copying a curve between layers**: motion paths and camera paths share this world-pixel space, so `points`/`closed` can be assigned across them literally. A shape outline lives in its own unit box: convert it through the source shape's Width/Height, `zoom` and Position to land where the shape is drawn (the editor does this when it copies a path).
- `keyframesPerPoint*` is bookkeeping for the "one key per anchor" convenience: one evenly-spaced `motionPathT` key per anchor, a closed path adding the final 100 key back to anchor one. Omit it and author any valid progress track directly.
- The normal preview, 3D view, WebCodecs export, and `/render-onserver` all evaluate the same curve.
- **To draw the curve as a visible trail**, add a `line` shape layer on its own channel below the rider. Take the path's bounding box with the handle ends included (`w`, `h`, centre `cx`, `cy`), size the line to it (`shapeSizeUnit: "px"`, `shapeWidthPx: w`, `shapeHeightPx: h`), pan it onto the box centre, and write its points as `x = (X − cx) / w`, `y = −(Y − cy) / h` (handles: `hx = HX / w`, `hy = −HY / h`) — a closed path becomes an open line with its first anchor repeated at the end. Set `panZ` to the path's mid-depth plus the rider's `motionPathOffsetZ` **minus 2**: coplanar with the layer riding it, the two planes would intersect under any camera move. The trail is a snapshot; the two are independent afterwards.

#### Ready-made path shapes

The editor's 19 Motion Path presets, centred on the composition. Coordinates are multiples of `s = 0.2315 × min(width, height)` (250 px on a 1920×1080 or 1080×1920 frame), y up, `z` = the layer's depth; round to 0.01 px. **smooth** = handles from the [tangent rule](video-shapes.md#writing-the-handles) (open or closed as listed); **corner** = zero handles; listed handles are exact, unlisted ones are zero.

| Preset | Kind | Anchors (× s) |
| --- | --- | --- |
| Arc | open, smooth | (−1.45, −0.55), (0, 0.62), (1.45, −0.55) |
| S-Curve | open | (−1.5, −0.65) with hOut (0.95, 0); (1.5, 0.65) with hIn (−0.95, 0) |
| Corner | open | (−1.35, −0.8) with hOut (0, 0.75); (1.4, 0.55) with hIn (−1.5, 0) |
| U-Turn | open, smooth | (1.5, 0.55), (−0.4, 0.55), (−1.05, 0), (−0.4, −0.55), (1.5, −0.55) |
| Wave | open, smooth | k = 0…5: (−1.5 + 0.6k, +0.42 for even k / −0.42 for odd k) |
| Zigzag | open, corners | the Wave anchors |
| Bounce | open | (−1.5, 0.78) hOut (0.3, 0); (−0.75, −0.62) hIn (−0.2, 0.9333); then floor anchors at x = 0.1, 0.75, 1.2, 1.5 (y −0.62). Each hop of width `w` and height `h` between two floor anchors: left hOut (w/3, 4h/3), right hIn (−w/3, 4h/3), with (w, h) = (0.85, 0.62), (0.65, 0.4), (0.45, 0.24), (0.3, 0.13) |
| Loop | open, smooth | (−1.55, −0.37), (0.08, −0.37), (0.52, 0.06), (0.08, 0.48), (−0.36, 0.06), (0.12, −0.35), (1.55, −0.37) |
| Swing | open, smooth | 5 points on a circle of radius 1.6 centred at (0, 1.05), at 240°, 255°, 270°, 285°, 300° |
| Spring | open, smooth | k = 0…18, o = k/18, θ = 6π·o: (−1.35 + 2.7·o − 0.32·sin θ, 0.32·cos θ) |
| Spiral In | open, smooth | k = 0…14, i = k/14, θ = π + 4.5π·i, r = 0.97·(1 − i)^0.9 + 0.03: (1.3·r·cos θ, r·sin θ) |
| Spiral Out | open, smooth | the Spiral In anchors in reverse order, handles recomputed |
| Circle | closed | (r, 0) hOut (0, c); (0, r) hOut (−c, 0); (−r, 0) hOut (0, −c); (0, −r) hOut (c, 0); every hIn = −hOut; r = 0.95, c = 0.5523·r |
| Orbit | closed | the Circle construction as an ellipse: (1.4, 0) hOut (0, 0.2761); (0, 0.5) hOut (−0.7732, 0); (−1.4, 0) hOut (0, −0.2761); (0, −0.5) hOut (0.7732, 0); every hIn = −hOut |
| Figure 8 | closed, smooth | k = 0…7, a = k·π/4: (1.4·sin a, 0.72·sin 2a) |
| Heart | closed | k = 0…11, θ = k·π/6, u = 0.072: (16u·sin³θ, u·(13 cos θ − 5 cos 2θ − 2 cos 3θ − cos 4θ) + 0.18); k = 0 and 6 are corners, the rest smooth |
| Square | closed | a rounded rectangle, half-size 1.15 × 0.68, corner radius 0.32, c = 0.1767: (1.15, −0.36) hIn (0, −c); (1.15, 0.36) hOut (0, c); (0.83, 0.68) hIn (c, 0); (−0.83, 0.68) hOut (−c, 0); (−1.15, 0.36) hIn (0, c); (−1.15, −0.36) hOut (0, −c); (−0.83, −0.68) hIn (−c, 0); (0.83, −0.68) hOut (c, 0) |
| Triangle | closed, corners | (0, 0.78), (−1.05, −0.55), (1.05, −0.55) |
| Star | closed, corners | 5 anchors in pentagram order, angle 90° + 72°·t for t = 0, 2, 4, 1, 3: (1.05·cos, 0.9·sin) |

#### Smoothing / reducing any path — `POST /api/paths/smooth`

A traced, tracked or hand-drawn path arrives with far more anchors than anyone wants to fine-tune (a rotoscoped mask, a motion-tracker export, a 44-point spiral). This endpoint rewrites a point list with fewer, cleaner anchors, and it is the **same code the editor's path smoothing runs**, so an agent-smoothed path is identical to one smoothed in the editor.

It is **stateless and path-agnostic** — every path in the app stores the same anchor shape, so read the points out of the project, post them here, and write the result back where you found them. Works for `item.motionPath.points`, `item.shapePath.points`, `item.cameraPath.points`, a layer mask's `path.points`, and any `shapePath`/`msk:<mid>:path`/`motionPathPoints` keyframe value.

```json
{
  "points": [ { "x": 0, "y": 0, "hIn": { "x": 0, "y": 0 }, "hOut": { "x": 0, "y": 0 }, "manual": true } ],
  "closed": false,
  "mode": "fit",
  "amount": 34,
  "limit_points": true,
  "max_points": 24,
  "corner_deg": 34
}
```

Body fields (defaults): `points` (required, 3–5000 anchors; the example shows one), `closed` (false), `mode` (`fit`), `amount` (34), `epsilon` (null — overrides `amount`), `corner_deg` (34), `limit_points` (true) with `max_points` (24) — caps the anchor count, `even_count` (12, for `even`), `relax_strength` (45), `relax_passes` (4) and `relax_pin_corners` (true, for `relax`), and `kept_indexes` (replay a `reduce`, below).

Response: `{ "points": [...], "stats": { "before", "after", "removed", "corners", "maxDeviation", "maxDeviationPct", "meanDeviation", "lengthDeltaPct", "epsilon", "keptIndexes" } }`. The returned points are ready to assign straight back (handles as offsets, `manual: true`, `z` only when the input had it).

**Pick the mode by what must be preserved:**

| `mode` | What it does | Anchor count | Use when |
| --- | --- | --- | --- |
| `fit` (default) | Refits the curve with as few cubic segments as the tolerance allows | Chosen by the tolerance; anchors land in **new** places | The general "this has too many points" case |
| `reduce` | Deletes only the redundant anchors, refits the handles around them | Chosen by the tolerance; survivors keep their **exact** coordinates | Anchors carry per-point data (`rx`/`ry`/`rz`) or the path is keyframed |
| `even` | Rebuilds with exactly `even_count` anchors at equal arc length | Exactly `even_count` | A specific count is needed (e.g. to match another key) |
| `relax` | Averages out the shake, keeping every anchor | **Unchanged** | Tracked / hand-drawn paths whose count is fine but whose shape wobbles |

- `amount` (0–100) is the single tolerance knob; ~8 is a light tidy-up, ~48 is aggressive. Pass `epsilon` instead to set the tolerance directly in the path's own units. Tolerance is measured as a share of the path's bounding box, so the same `amount` behaves the same on a 1920 px motion path and a ±0.5 unit-box mask.
- `corner_deg` keeps turns sharper than that many degrees as **corners**. This is what lets a star stay a star: at the default a traced 10-point star refits to exactly 10 anchors with zero deviation, while `corner_deg: 180` (corner detection off) spends 20 anchors and is still less accurate. Raise it to deliberately round a spiky path off.
- Check `stats.maxDeviationPct` before writing the result back — under ~0.4 % of the bounding box is visually identical, over ~1.5 % is a visible shape change. `mode: "even"` with a small count can move the curve a long way; the number tells you so.
- **A keyframed path must keep the same point count in every key** — a shape morph, a mask path track and a one-key-per-anchor `motionPathT` track all pair point 3 of one key with point 3 of the next. So: smooth the key you can see with `mode: "reduce"`, then replay that exact reduction on every other key by posting each one with `{"points": <that key>, "kept_indexes": <stats.keptIndexes from the first call>}`. `mode: "even"` (same `even_count` for every key) and `mode: "relax"` are also safe. **`mode: "fit"` is not** — it picks its own count per key, so key 1 lands on 9 anchors, key 2 on 11, and the morph breaks.
- Changing the count of a motion/camera path invalidates a one-key-per-anchor progress track: rebuild `motionPathT` / `camPathT` with evenly spaced keys (see `keyframesPerPoint` above) or leave the plain 0→100 pair.
- Errors are HTTP 400: fewer than 3 points, more than 5000, an unknown `mode`, or a degenerate (zero-length) path.

#### Text on Path (`textPathEnabled`)

A **text** item with a motion path can lay its glyphs out along the curve instead of (or as well as) riding it. Fields (all on the item, sanitized defaults shown):

```jsonc
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
  "textPathRotate": true,            // align each unit with the curve tangent
  "textPathCorners": "smooth"        // 'smooth' = units turn with the curve | 'sharp' = a unit never straddles a bend
}
```

Strip the `//` comments before sending.

- Placement is arc-length parameterised (kerning survives corners) and uses the same curve evaluation as Follow Path, so preview, WebCodecs export and `/render-onserver` agree.
- **Progress reuses `motionPathT` + its Path Progress track** and moves every glyph along the curve (not the block as one object). A closed untrimmed loop wraps like a marquee; an open or trimmed path extrapolates straight past its end tangents, so text can slide onto/off the curve. The trims move the WINDOW the run is laid out in — they do NOT hide letters (those run on past the window's ends), so keyed trims are not a write-on: use a Text Animator reveal for that. Letters that run past the path's own ends are cut at the text plate's edge — extend the path to run text off the frame.
- `textPathDirection` decides where the run rests at 0 % and which way progress carries it: `forward` parks the text ON the first point and travels to the last, `backward` ends it on the last point and travels back to the first, `center` (default) anchors the run in the middle of the window and follows `textAlign` (start/centre/end of the trimmed window). Multi-line text stacks rows along the curve normal at line-height steps.
- `textPathTravel` sets how far 100 % carries a forward/backward run: `fit` (default) stops when the run's far end reaches the far point, so the whole text stays on the path; `through` keeps going until the leading unit gets there, sliding the text off the end. Travel is computed per row (each row's run has its own length), and a run longer than the trimmed window has nowhere to travel under `fit`. Ignored by `center` (which always slides the full window) and by a wrapping closed loop (always a whole lap).
- `textPathCorners: "sharp"` treats bends as corners (a turn of 20°+ within ¾ of the type size, or half the unit if wider): a unit never takes an in-between angle on a bend — it belongs wholly to ONE side, turned to that side and laid on that side's straight line carried through the bend. The side is the one it RESTS on (Path Progress 0), so a glide or drift shorter than half a unit never turns a letter at a corner; a unit carried further (a marquee round a square) moves across when its centre passes the middle of the bend. Use it for text running or gliding round a square / ∩ path (rounded corners included); keep `smooth` for curves (an outline, a wave).
- While `textPathEnabled` is live (path has ≥2 points), `follow` is ignored — the glyph run owns the curve and the layer's own transform stays put. The caption background bar (`textBgEnabled`) is suppressed on a path; split/in-out animations, highlight, randomizer and word timings all compose per unit on the curve.
- `follow` is NOT required: draw a path, leave `follow: false`, set `textPathEnabled: true`.

#### Animated motion path (`motionPathPoints`)

The path ITSELF can be keyframed, like a Layer Mask outline: `propertyKeyframes.motionPathPoints` holds snapshots of the points, and Follow Path and Text on Path both ride the snapshot at the current frame — so text can follow a tracked (RotoScope) outline frame by frame.

```jsonc
"propertyKeyframes": {
  "motionPathPoints": [
    { "position": 0,   "value": "[{\"x\":-520,\"y\":0,\"z\":0,\"hIn\":{\"x\":0,\"y\":0,\"z\":0},\"hOut\":{\"x\":0,\"y\":0,\"z\":0},\"manual\":true}, …]", "easing": "Linear" },
    { "position": 100, "value": "[…the same points, moved…]", "easing": "Linear" }
  ]
}
```

- **Value:** a JSON string of the points in the WORLD space of `motionPath` (pixels, origin at the comp centre, +y up, z toward the viewer, handles as offsets, optional `rx/ry/rz`). `closed`, `follow`, `aim` stay on `item.motionPath`.
- **Same point count in every key**; the shorter list wins if they differ. Dense (per-frame) tracks use `Linear` keys.
- **Keep `item.motionPath`** with the same points (any key's): the track is only kept while the layer has a path of 2+ points, and point counts / Text on Path liveness read it.
- **Adding or deleting an anchor** changes every key, split at the same spot of the curve.
- **Copying from an ANIMATED source** (a RotoScope mask, a keyed shape path or another animated motion path) brings all its keys, at their absolute times on this layer's span, cut with an interpolated key where the source runs past either end, as the editor's copy does.
- **Text on Path:** the text plate is sized from the reach of ALL keys once, so the outline can move without the texture being reallocated.

### Motion-track follow (`motionTracks` + `motionFollow`)

A layer that rides a motion-tracked point (`motionFollow`: ride, pin, lock, and the offset rule) and the track data it reads (`item.motionTracks`) are documented in tracking-data.md (GreenLight Dash only).
