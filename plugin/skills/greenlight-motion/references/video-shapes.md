> **GreenLight Motion Engine:** this is the GreenLight Dash Video Editor's project format, which the engine reads as is.
> Ignore the `/api/...` routes and the app UI described here: in the engine you edit `project.json` (or `apply`) and run
> `npx greenlight-motion build`; what `GET /api/video-editor/capabilities` returns there is `npx greenlight-motion schema <topic>`
> here. `frontend/src/…` paths are files of the engine's public source repository. MotionFast templates (`mediaType: "motion"`)
> stay in GreenLight Dash.

# GreenLight Dash — Shape layers

> Read [video-projects.md](video-projects.md) for the shared project, clip, channel, timing and versioned-write contracts. Load only the sections needed for the task.

## Contents

- [Shape layers (`mediaType: "shape"`)](#shape-layers-mediatype-shape)
  - [Sizing (`shapeSizeUnit`)](#sizing-shapesizeunit)
  - [Rounded rectangles — buttons, pills, cards](#rounded-rectangles--buttons-pills-cards)
  - [Fill, opacity and framing on shapes](#fill-opacity-and-framing-on-shapes)
  - [Editable paths (`shapeType: "path"`, `shapePath`)](#editable-paths-shapetype-path-shapepath)
  - [Writing the handles](#writing-the-handles) — the tangent rule for every path in the app
  - [Lines and strokes](#lines-and-strokes)
  - [Shape background (`shapeBackground`)](#shape-background-shapebackground)
  - [Clipping masks (`shapeClipMask` / `textClipMask` / `clipMaskInvert`)](#clipping-masks-shapeclipmask--textclipmask--clipmaskinvert)
  - [Track matte (`trackMatte`)](#track-matte-trackmatte)
  - [Card framing on every visual layer](#card-framing-on-every-visual-layer) — rounded corners, borders and shadows on video, image, text and sequences
  - [Backdrop blur and glass](#backdrop-blur-and-glass)
  - [Traced vectors (`shapeType: "vector"`)](#traced-vectors-shapetype-vector)

### Shape layers (`mediaType: "shape"`)

A solid-colour rectangle / ellipse / arrow / triangle — or a custom SVG silhouette — with the full photo-layer option set (transforms, filters, keyframes, layer transitions, blend modes). Like text, the clip is synthetic (no `url`) and the LOOK lives on the timeline item:

```jsonc
// clip
{ "id": "shp1", "source": "LOCAL", "mediaType": "shape", "url": "", "proxyUrl": null, "name": "Shape", "duration": 5 }
// item fields (on the timeline item referencing shp1; defaults shown)
{ "shapeType": "rectangle", "shapeFillColor": "#8b5cf6", "shapeSizeUnit": "pct", "shapeWidthPct": 40, "shapeHeightPct": 40, "shapeWidthPx": null, "shapeHeightPx": null, "shapeRadiusPct": 20, "shapeRadiusPx": null, "shapeSvgUrl": null, "shapePath": null, "shapeClipMask": false, "clipMaskInvert": false }
```

`shapeType` is one of `rectangle` | `ellipse` | `circle` | `arrow` | `triangle` | `path` | `line` | `custom` | `vector`; an unknown value loads as `rectangle`.

- **Triangles** take `shapeTriDirection` (`up`|`down`|`left`|`right`, default `up`) and `shapeTriApexPct` (0–100, default 50 — where the tip sits along the opposite edge; 0/100 gives a right triangle).
- **Arrows** take `shapeArrowHeadPct` (head length as % of width, 5–90, default 45) and `shapeArrowShaftPct` (shaft thickness as % of height, 2–100, default 42).
- **`custom`** renders a user-provided SVG silhouette: set `shapeSvgUrl` to an SVG **data URI** (`data:image/svg+xml;base64,…` or URL-encoded) — the SVG's alpha is the shape and it is recoloured with `shapeFillColor`, so it travels inside the project JSON with no media file. Stills and exports load every `shapeSvgUrl` in the project before the first frame, so an icon whose clip starts mid-timeline appears on its first frame (the live preview loads it on first display).
- **`vector`** is a traced image: see [Traced vectors](#traced-vectors-shapetype-vector).
- **`path`** and **`line`** are editable bezier outlines: see [Editable paths](#editable-paths-shapetype-path-shapepath) and [Lines and strokes](#lines-and-strokes).

The size is keyframable in the unit the shape uses: tracks `shapeWidthPx`/`shapeHeightPx` or `shapeWidthPct`/`shapeHeightPct` (a circle: `shapeRadiusPx` or `shapeRadiusPct`), each overriding the field of the same name — a track for the unit not in use does nothing. Shapes render in `/render-onserver` (not the fast `/render`). Put shapes on their own `unsnapped` channel above the footage, like captions.

#### Sizing (`shapeSizeUnit`)

`"pct"` (the default) reads `shapeWidthPct` as % of the composition **width** and `shapeHeightPct` as % of its **height** — two different bases, so equal percentages are only square on a square composition: `40`/`40` on 1920×1080 is a 768×432 oval. Both may exceed 100. `"px"` reads `shapeWidthPx`/`shapeHeightPx` as absolute composition pixels instead (a `null` px value falls back to the %), and may exceed the composition size.

**To draw a circle, size it in px, never in matching percentages**: either `shapeType: "circle"`, which takes a single radius (`shapeRadiusPx` with `shapeSizeUnit: "px"`; its `shapeRadiusPct` fallback is % of the *shorter* composition side, default 20, so it stays round but changes size with the aspect ratio), or an `ellipse` with `shapeSizeUnit: "px"` and equal `shapeWidthPx`/`shapeHeightPx`. Do the same for any shape that must keep its proportions across compositions (a square, a 1:1 badge).

#### Rounded rectangles — buttons, pills, cards

For anything with rounded corners — a button, pill, badge, tag, card, chat bubble, progress-bar track — use a `rectangle` shape with `borderRadius`. Do not reach for the `Rounded`/`Squircle` path presets or size the layer with `zoom`/`scaleX`/`scaleY`: a path's corners and a scaled layer both stretch with the box, while `borderRadius` is resolved against the box actually drawn, so changing (or keyframing) `shapeWidthPx`/`shapeHeightPx` — a button that grows to fit its label — keeps every corner the same.

- `borderRadiusUnit`: `"px"` (default; composition pixels — a fixed corner) or `"pct"` (% of the shape's **shorter** side, 0–50). `50` is a full pill/capsule at any aspect ratio. Any radius larger than half the shorter side clamps there, so `borderRadius: 9999` in px is also a pill.
- `borderRadius` is the radius for all four corners (default 0 = square). For different corners set `borderRadiusLinked: false` and `borderRadiusTL` / `borderRadiusTR` / `borderRadiusBR` / `borderRadiusBL`, in the same unit (a corner left out falls back to `borderRadius`) — e.g. a tab with only its top corners rounded.
- **Animate it** with the `borderRadius` property-keyframe track (`borderRadiusTL` … `borderRadiusBL` when unlinked). Values are in the item's `borderRadiusUnit`; `"0"` is square, so `0 → 50` in `pct` morphs a square box into a pill. Changing `borderRadiusUnit` through the API does not convert existing keys, so rewrite them in the new unit.
- When the layer itself must scale (a tile that grows to fill the frame, a card that punches in on a `scale` track), set `borderRadiusScaleLock: true`. Every radius is then divided by the layer's scale (`zoom`, the `scale`/`scaleX`/`scaleY` tracks and its parents), so the corner keeps its size on screen instead of growing with the tile. Without it (the default) the corner scales with the layer.
- Only `rectangle` shapes take a `pct` radius. Every other layer (video, image, text, sequence) takes the radius in px, and its `borderRadius` tracks too (see [Card framing](#card-framing-on-every-visual-layer)); `shapeRadiusPct`/`shapeRadiusPx` are a `circle`'s size, not a corner amount.
- `borderWidth`/`borderColor`/`borderStyle` stroke the rounded outline, and `shadows` and `backdropBlur` follow it.

A pill button — the label is a text layer on the channel above, at the same `panX`/`panY`:

```json
{ "shapeType": "rectangle", "shapeSizeUnit": "px", "shapeWidthPx": 360, "shapeHeightPx": 96,
  "shapeFillColor": "#2563eb", "borderRadius": 50, "borderRadiusUnit": "pct",
  "propertyKeyframes": { "shapeWidthPx": [
    { "position": 0, "value": "96", "easing": "AE Smooth" },
    { "position": 40, "value": "360", "easing": "AE Smooth" }
  ] } }
```

A 12 px-corner card is `"borderRadius": 12` with no unit field.

#### Fill, opacity and framing on shapes

- **Fill opacity comes from the alpha of `shapeFillColor`** — use an rgba/8-digit-hex value (e.g. `rgba(139,92,246,0.5)` or `#8b5cf680`) for a semi-transparent fill; there is no separate fill-opacity field.
- Position/scale/rotation come from the standard item fields (`panX`, `panY`, `zoom`, `rotateZ`, keyframes…). For a whole-layer fade use the standard item `opacity` (0–100; its keyframe track is 0–1).
- On shape layers the framing fields follow the **shape outline**, not the bounding box: `borderWidth`/`borderColor`/`borderStyle` stroke the outline (all four styles; not on `custom`/`vector` SVG shapes or stroked paths and lines, which use the [line stroke](#lines-and-strokes) instead), and drop `shadows` hug the silhouette (shadow `spread` and `inset` are ignored for shapes).

#### Editable paths (`shapeType: "path"`, `shapePath`)

A freeform bezier outline instead of a parametric one. `shapePath` is `{ "points": [ … ], "closed": true }`; each point is `{ "x", "y", "hIn": {"x","y"}, "hOut": {"x","y"}, "manual": true }`. Coordinates are **fractions of the shape's own box, centred on it** — `-0.5` is the left/top edge and `0.5` the right/bottom (+y down) — so `shapeWidthPct`/`shapeHeightPct` still size the whole path (points may go outside ±0.5; the render surface grows to fit). Anchors **and** handles are clamped to **±8** box units on load. Write the handles as described in [Writing the handles](#writing-the-handles).

`closed: false` (or `shapePathRenderMode: "stroke"`) draws the path as a **stroked line** with the [line stroke fields](#lines-and-strokes) instead of a filled shape; an open path cannot be a clipping mask.

**Ready-made outlines** come from `GET /api/video-editor/capabilities` → **`paths`**: `paths.shapePresets` holds 11 closed shapes (Circle, Rectangle, Rounded, Triangle, Diamond, Pentagon, Hexagon, Star, Burst, Blob, Squircle) and `paths.linePresets` 6 open ones (Straight, Arc, S-curve, Wave, Zigzag, Corner), each as a complete point list with handles already resolved and `manual: true` set — paste one and it renders exactly as published. Take the points from there rather than approximating a shape by hand; on a keyframed outline, write the resampled points into a key instead of the base field.

**Reusing another curve as an outline.** A motion path or camera path can become a shape outline: world-pixel curves are fitted into **this** shape's box with a single scale for both axes (keeping proportions rather than stretching to the box), centred on it, and flattened — `z` is dropped, since a shape draws its XY footprint, and y flips (world +y is up, the box's +y is down).

The outline is keyframable as a whole under the `shapePath` **property-keyframe track** — one of the track kinds whose `value` is a JSON array of points rather than a number or colour (the others are a layer mask's `msk:<mid>:path`, see [Layer Mask entry](video-effects.md#layer-mask-entry), and `motionPathPoints`, see [video-paths.md](video-paths.md#animated-motion-path-motionpathpoints)). Every key must hold the **same number of points**, since they morph one-to-one:

```jsonc
"propertyKeyframes": { "shapePath": [
  { "position": 0,   "value": "[{\"x\":-0.5,\"y\":-0.5,\"hIn\":{\"x\":0,\"y\":0},\"hOut\":{\"x\":0,\"y\":0},\"manual\":true}, …]", "easing": "Smooth" },
  { "position": 100, "value": "[…same length…]", "easing": "Smooth" }
] }
```

The track is only kept on load when the item's `shapeType` is `path` or `line`.

#### Writing the handles

One rule covers every bezier path in the app: `shapePath`, line outlines and Layer Mask paths (unit box, `x`/`y`), and `motionPath`, `cameraPath` and `motionPathPoints` keys (world pixels, `x`/`y`/`z` — every handle carries `z` too). `GET /api/video-editor/capabilities` → `paths.anchor` / `paths.spaces` / `paths.tangents` restate it.

`hIn`/`hOut` are the cubic-bezier control handles stored as **offsets from their own anchor**, not absolute control points — the segment A→B is the cubic `A → A+A.hOut → B+B.hIn → B`. **Write both handles on every anchor.** A missing or zero-length handle is a hard **corner**, and nothing fills one in: the auto-tangent pass runs only on a hand edit in the editor, while load, save, preview, export and `/render-onserver` draw the stored handles verbatim. An outline written as bare points renders as a straight-line **polygon**, not the smooth shape it looks like on paper. Set **`manual: true` on every anchor** too, or the next hand edit in the editor re-smooths the whole outline out from under the design.

- **Smooth anchor** — the editor's own Catmull-Rom tangent, componentwise: `hOut = (P[next] − P[prev]) / 6`, `hIn = −hOut`. On a `closed` path the neighbours wrap; on an open one the first anchor uses `hOut = (P[1] − P[0]) / 3` and the last `hIn = −(P[last] − P[last−1]) / 3`.
- **Corner** — `hIn` and `hOut` both `{ "x": 0, "y": 0 }` (plus `"z": 0` in world space).
- **Cusp with curvature on both sides** — break the mirror: give `hIn` and `hOut` directions that are not opposite.
- **Circular arc** — a quarter-arc wants handles of `0.5523 × radius` laid **perpendicular** to the anchor's radius, following the winding: `0.2761` in the ±0.5 box (that is the Circle preset). Longer handles bulge the arc (Squircle uses 1.34×), shorter ones flatten it.

#### Lines and strokes

A `line` is an editable path that renders as a **stroke** rather than a fill (its `closed` flag is ignored — a line is always open). A `path` is stroked the same way when `closed: false` or when `shapePathRenderMode` is `"stroke"` (default `"fill"`) — what you want for a signature, a route line or any figure where a fill would close the curve. Stroke fields, all on the item: `lineWidth` (px, 0–400, default 8), `lineCap` (`butt`|`round`|`square`, default `round`), `lineJoin` (`round`|`miter`|`bevel`, default `round`), `lineDash` (`solid`|`dashed`|`dotted`|`custom`, default `solid`). The stroke is painted with the shape's own fill, so `shapeFillColor` **and** a full `shapeBackground` (gradient / shader / pattern / image) both work on a line. The card `borderWidth`/`borderStyle` do **not** apply — the stroke is the outline.

**Trim Paths (`lineTrimStart` / `lineTrimEnd` / `lineTrimOffset`).** Draw only part of the outline, measured by arc length: `lineTrimStart` and `lineTrimEnd` are 0–100 (default 0 and 100), `lineTrimOffset` is −100…100 (default 0) and slides the span along the path, wrapping on a closed one. Keyframing `lineTrimEnd` 0 → 100 is the "write the line on" move. Trim applies to any stroked shape.

**More stroke fields (flat, on the item).** Set only what you need — absent means default.
- `lineDash` also takes `"custom"`, which reads `lineDashPattern`: `[dash, gap, dash2, gap2]` in px (each 0–400, default `[30, 18, 0, 0]`; a zero dash with round or square ends draws a dot).
- Any non-solid dash also takes `lineDashOffset` (px, −1000…1000), `lineDashSpeed` (px/s, −400…400 — the dashes march along the path on their own), `lineDashCap` (`line` = same as `lineCap` | `butt` | `round` | `square`) and `lineDashFit` (bool — stretches the pattern so it ends cleanly at both path ends). Dashes are anchored to the path, so a trim draw-on reveals them in place instead of dragging them along.
- `lineStyle`: `solid` (default) | `outline` with `lineOutlineWidth` (0.5–40 px, default 3) — only the edge of the stroke is drawn, and arrowheads and stamps are outlined as one shape with it.
- `lineTrimEach` (bool): trims every anchor-to-anchor segment separately, so all segments draw on at once.
- `lineGhost` (0–100 %, default 0): a faint full-length copy of the stroke under the trimmed one — the "track the line draws along".

**Stroke options (`lineStroke`).** An object whose keys are the options in use; a missing key means the option is not on the layer, and `enabled: false` mutes one without losing its settings. Unknown keys are dropped and every number is clamped to the ranges below (defaults in parentheses):

| Key | Fields |
| --- | --- |
| `taper` | `follow` (`trim` \| `path` \| `dash`, `trim`) — what the lengths are measured along: `trim` = the visible drawn span (a comet while trim animates), `path` = the whole path, `dash` = each dash on its own. `startLength`/`endLength` (0–100 % of that span, 30/30), `startWidth`/`endWidth` (0–100 % of `lineWidth` at the tip, 0/0), `startEase`/`endEase` (0 straight → 100 round nose, 0/0). |
| `profile` | `preset` (`lens` \| `bulge` \| `taperStart` \| `taperEnd` \| `fishtail` \| `spindle` \| `teardrop` \| `beads` \| `pulse` \| `steps` \| `custom`, `lens`), `points` (for `custom`: 2–32 `{x, y}`, x 0–1 along the span, y 0–1 of `lineWidth`; the first and last are pinned to x 0 and 1), `repeat` (1–40, 1), `offset` (0–100 % of one period, 0), `flow` (periods/s, −3…3, 0), `min` (0–100 % width floor, 0). |
| `widthWave` | `amount` (0–100 %, 60), `wavelength` (4–800 px, 120), `phase` (0–360°, 0), `speed` (cycles/s, −6…6, 0). |
| `brush` | `nib` (`round` \| `calligraphic`), `nibAngle` (−90…90°, 35), `nibRoundness` (0–100 %, 20), `pressure` (0–100 %, 0), `pressureScale` (20–1200 px, 300), `rough` (0–100 %, 0 — ragged edges), `roughScale` (1–80 px, 10), `boil` (0–24 fps, 0 — re-rolls the noise that many times a second, the hand-drawn look), `seed` (1–99, 7). |
| `warp` | Applied in this order: `roundCorners` (0–300 px), `offset` (−150…150 px), zig zag `zigzagSize` (0–120 px) / `zigzagRidges` (1–160, 24) / `zigzagPoints` (`corner` \| `smooth`) / `zigzagSpeed` (ridges/s, −8…8), wiggle `wiggleSize` (0–160 px) / `wiggleDetail` (wiggles per 1000 px, 0.5–40, 5) / `wiggleRate` (/s, 0–12, 1.5) / `wigglePinEnds` (true), wave `waveAmplitude` (0–240 px) / `waveLength` (20–1400 px, 320) / `waveSpeed` (px/s, −2000…2000) / `wavePinEnds` (true). |
| `copies` | `mode` (`parallel` \| `repeater`), `count` (1–24, 3), `spacing` (parallel, −120…120 px, 30), `moveX`/`moveY` (px per copy), `rotate` (° per copy, 15), `scale` (% per copy, 50–150, 95), `widthFalloff`/`opacityFalloff` (0–100 %), `color` (`same` \| `cycle` \| `across`) with `colors` (2–3 `#rrggbb`), `stagger` (0–2 s — each copy plays the keyframed `lineTrim*` tracks that much later), `order` (`forward` \| `reverse` \| `center`), `blend` (`normal` \| `add`). |
| `ends` | `start`/`end` (`none` \| `arrow` \| `stealth` \| `open` \| `circle` \| `ring` \| `square` \| `diamond` \| `bar`; `none`/`arrow`), `size` (× `lineWidth`, 1–12, 3.2), `followTrim` (true — the heads ride the trimmed ends; false pins them to the path ends), `grow` (true — heads scale in while the drawn span is shorter than the head). A head pulls the stroke back by its own length, so the line never pokes through the tip. |
| `stamps` | `shape` (`dot` \| `ring` \| `square` \| `diamond` \| `triangle` \| `chevron` \| `star` \| `bar` \| `heart` \| `cross`), `mode` (`only` \| `below` \| `above` the stroke), `spacing` (2–300 px, 36), `offset` (px), `speed` (px/s — the stamps march), `size` (px, 18), `aspect` (10–400 %), `followWidth` (true — size follows taper/profile), `rotation` (`follow` \| `fixed` \| `random`), `angle` (°), `jitterSize`/`jitterRotation`/`jitterOffset`, `seed`, `color` (`#rrggbb`, or `null` = the stroke's paint). |
| `paint` | `mode` (`fill` = the shape's own fill \| `gradient` \| `rainbow`, `gradient`), `colors` (2–3 `#rrggbb`), `span` (`path` \| `trim` \| `dash`), `repeat` (1–12), `mirror` (true), `offset` (0–100 %), `flow` (/s), `core` (false) with `coreColor`/`coreWidth`/`coreSoftness` (a bright centre line), `fadeIn`/`fadeOut` (0–100 % of the taper span). |

The width profile and the fades are measured along the same span as `taper.follow` (the visible trimmed span when there is no `taper`). With any of these fields the stroke is still painted with the shape's own fill (`shapeFillColor` or `shapeBackground`) unless `paint.mode` is `gradient` or `rainbow`, `copies.color` is not `same`, or `stamps.color` is set. Stamps ride the uncopied path only.

A tapered arrow that writes itself on:

```json
{ "shapeType": "line", "lineWidth": 12, "lineCap": "round", "shapeFillColor": "#fbbf24",
  "lineStroke": {
    "taper": { "follow": "trim", "startLength": 60, "endLength": 0, "startWidth": 0 },
    "ends": { "start": "circle", "end": "stealth", "size": 4 }
  },
  "lineGhost": 12,
  "propertyKeyframes": { "lineTrimEnd": [
    { "position": 0, "value": "0", "easing": "AE Smooth" },
    { "position": 70, "value": "100", "easing": "AE Smooth" }
  ] } }
```

**Stroke keyframe tracks.** Every value that can move is a numeric (or colour) **property-keyframe track** on `propertyKeyframes`, kept on load only for a stroked shape; choices and on/off switches (`lineCap`, `lineJoin`, `lineDash`, `follow`, `mode`, `preset`…) are static.
- Flat fields: `lineWidth`, `lineTrimStart`, `lineTrimEnd`, `lineTrimOffset`, `lineDashOffset`, `lineDashSpeed`, `lineOutlineWidth`, `lineGhost`, and the custom dash pattern as `lineDashLength1`, `lineDashGap1`, `lineDashLength2`, `lineDashGap2`.
- `lineStroke` numbers: a track named `line` + card key + field, both capitalised — `lineBrushNibAngle`, `lineWarpZigzagRidges`, `lineCopiesRotate`, `lineStampsSpacing`, `linePaintRepeat` … — except these, which keep their own names: `lineTaperStartLength`, `lineTaperEndLength`, `lineTaperStartWidth`, `lineTaperEndWidth`, `lineProfileOffset`, `lineWidthWaveAmount`, `lineWidthWavePhase`, `lineWarpOffset`, `lineZigzagSize`, `lineWiggleSize`, `lineWarpWaveAmplitude`, `lineCopySpacing`, `lineEndsSize`, `lineStampOffset`, `lineGradientOffset`, `lineFadeIn`, `lineFadeOut`.
- `lineStroke` colours (key `value`s are CSS colours, interpolated as colours): `linePaintColor1`–`3` and `lineCopiesColor1`–`3` (the entries of `colors`), `linePaintCoreColor`, and `lineStampsColor` (only recolours stamps that have their own `color`).

A track overrides its field only while that card is on the layer; values use the field's units and are clamped to its range.

Running Glow on a stroked shape should set `glowTraceThin: 1` and a `glowEdgeWidth` near the line's own thickness (in @1080 px) — the default filled-shape tracing finds no contour on a thin stroke and the effect is invisible.

#### Shape background (`shapeBackground`)

Beyond the flat `shapeFillColor`, a shape can take a full **background** via `shapeBackground` — the same `backgroundConfig` object as the project background (solid, gradient, GLSL shader, pattern, or image; the schema, preset ids and shader rules are in [video-backgrounds.md](video-backgrounds.md)). It fills the shape's silhouette; when `shapeBackground` is `null` (the default) the shape falls back to the flat `shapeFillColor`. Shader and animated-gradient shape backgrounds render only in the Video Editor.

#### Clipping masks (`shapeClipMask` / `textClipMask` / `clipMaskInvert`)

A shape can act as a **clipping mask**: set `shapeClipMask: true` and the layers below the shape's channel show only where the shape has coverage (the fill itself isn't drawn; the fill's alpha sets mask strength, and the shape's transforms/keyframes move the mask). **Text layers** take the same treatment with `textClipMask: true` — the glyph coverage is the matte, so footage plays inside the letters, and typography plus the split/stagger animation fields animate it. While a text layer masks, its own text shadow (`textShadowX/Y/Blur/Spread`) and caption bar (`textBgEnabled`) are ignored, as is card framing (`borderWidth`, `shadows`) — that alpha would leak into the matte; use the `blur` filter to feather instead. Either kind accepts `clipMaskInvert: true` to flip the matte (knockout: the layers below are hidden inside the shape/letters and shown everywhere else). A mask affects **all** channels below it in the same stack, masks stack, and they composite both at the top level and inside a sequence's inner timeline. A frame with an active mask skips the global Depth of Field.

#### Track matte (`trackMatte`)

The After Effects analog, distinct from clipping masks: it scopes to **one consumer layer** instead of the whole stack below, and supports luma. Set on the consumer item: `trackMatte: { sourceId: "<other item id>", mode: "alpha" | "alphaInverted" | "luma" | "lumaInverted" }` — the consumer then shows only where the source layer has alpha coverage (`alpha`) or brightness (`luma`; computed premultiplied, so transparent source areas contribute nothing), inverted variants flip it. The **source layer is hidden from output** while at least one active consumer references it; its transforms/keyframes still animate the matte.

- The source must be another **visual** item (not audio/camera/adjustment) at the **same editing level**; the reference is by item id, not stack position; several consumers may share one source.
- A mutual pair (A mattes with B while B mattes with A) is auto-broken on save.
- If the source clip isn't under the playhead the matte is EMPTY — `alpha`/`luma` hide the consumer, inverted modes show it untouched.
- The matte clips the consumer's **finished** look (after its filters, glow, overlay effects and motion blur), matching AE. The **source is read finished too**: its own `effects` chain, `layerEffects`, rig warp and motion blur shape the matte, so an `extract` (histogram key) or `alphaChoker` on the source layer is the normal way to author a matte from footage rather than from a silhouette.
- Works at the top level and inside a sequence's inner timeline alike (inside a sequence only the layer's `effects` chain shapes the matte — glow, motion blur and the other Layer Effects are top-level stages); grids strip it on grouping.

#### Card framing on every visual layer

Every visual layer (video/image/shape/text/sequence) supports **card framing** item fields, all in canvas px:

- **Rounded corners** — `borderRadius` (uniform, default 0); for per-corner radii set `borderRadiusLinked: false` and use `borderRadiusTL`, `borderRadiusTR`, `borderRadiusBR`, `borderRadiusBL` (each falls back to `borderRadius`). On media layers the radius is px; only `rectangle` shapes can also take a % of the shorter side ([Rounded rectangles](#rounded-rectangles--buttons-pills-cards)). It is keyframable on every layer: `propertyKeyframes.borderRadius` (the four corner tracks while unlinked) overrides the field for the frame, so a full-frame video can round into a card. The radius is drawn before the layer's scale, so a scaled picture's corners grow with it; `borderRadiusScaleLock: true` divides every radius by the layer's scale and keeps the corner's on-screen size. Border and shadows follow the rounded outline either way. A picture tile that grows 4× with a 24 px corner the whole way:

  ```json
  { "zoom": 0.25, "borderRadius": 24, "borderRadiusScaleLock": true,
    "propertyKeyframes": { "scale": [
      { "position": 0, "value": "1", "easing": "AE Smooth" },
      { "position": 100, "value": "4", "easing": "AE Smooth" }
    ] } }
  ```
- **Border** — `borderWidth` + `borderColor` (default 0 / `#ffffff`) + `borderStyle` (`solid` | `dashed` | `dotted` | `double`, default `solid`). `borderWidth` and `borderColor` are also keyframe tracks (`propertyKeyframes.borderWidth` in px, `propertyKeyframes.borderColor` as CSS colours) — a focus ring that grows, an outline that turns red on an error; a track overrides its field for the frame.
- **Shadows** — `shadows`: an array of up to 4 layers, each `{ x, y, blur, spread, color, inset }` (CSS box-shadow semantics; `inset: true` draws an inner shadow; the first entry sits on top). The single-shadow fields (`shadowX`, `shadowY`, `shadowBlur`, `shadowSpread`, `shadowColor`) are read when `shadows` is absent and are converted on load.

These bake into `/render-onserver` like everything else.

#### Backdrop blur and glass

- **Backdrop Blur** (shape layers ONLY — matte / frosted glass) — `backdropBlur` (px, 0–200, default 0 = off) blurs whatever is rendered **behind** the shape, inside its outline; the shape's own fill then draws over the blur, so a semi-transparent fill (`shapeFillColor: "rgba(255,255,255,0.25)"`) reads as frosted glass and a tinted one as smoked glass. `backdropSaturation` (%, 0–300, default 100) re-saturates the blurred backdrop (boost it for the iOS/macOS glass look). Both are keyframable as the `backdropBlur` / `backdropSaturation` tracks. The blur covers the shape's full coverage regardless of the fill's alpha (the plate alpha is normalised by the fill's peak alpha × `opacity`), fades with a gradient fill, and is ignored on clip-mask shapes and on every non-shape layer. A fully opaque fill hides the blur entirely — always pair `backdropBlur` with a semi-transparent `shapeFillColor`. (The editor thins a solid fill to 35 % when `backdropBlur` first goes above 0 and remembers the previous paint in `backdropGlassFill`; setting `backdropBlur` back to 0 there restores it unless the fill was edited since. The API does neither: set `backdropBlur: 0` AND the fill you want.)
- **Glass** (shape layers only: `rectangle`, `ellipse`, `circle`) — the `glass` Layer Effect turns the shape into a pane of real glass that refracts, frosts, tints and shadows everything rendered **behind** it; see [Glass entry](video-effects.md#glass-entry).

#### Traced vectors (`shapeType: "vector"`)

The editor's **Image to vector** tracer makes a `vector` shape: the traced artwork is drawn from `shapeSvgUrl` in its own colours (a `custom` SVG is recoloured with `shapeFillColor`; a `vector` one is not), contain-fitted in the shape's box. The layer keeps where it came from: `shapeVectorSourceUrl` (the bitmap it was traced from), `shapeVectorFileName` (that file's name, ≤ 240 chars), `shapeVectorPathCount` (how many sub-paths the trace produced), `shapeVectorTrace` (the tracer settings, so the trace can be re-run at a different threshold) and `shapeVectorEditablePath` (an editable outline: converting the layer to a `path` in the editor uses it, drawn as a stroke). Preserve all five when you edit such a layer, or the user loses the ability to re-trace or convert it.
