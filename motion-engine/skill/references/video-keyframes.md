> **GreenLight Motion Engine:** this is the GreenLight Dash Video Editor's project format, which the engine reads as is.
> Ignore the `/api/...` routes and the app UI described here: in the engine you edit `project.json` (or `apply`) and run
> `npx greenlight-motion build`; what `GET /api/video-editor/capabilities` returns there is `npx greenlight-motion schema <topic>`
> here. `frontend/src/…` paths are files of the engine's public source repository. MotionFast templates (`mediaType: "motion"`)
> stay in GreenLight Dash.

# GreenLight Dash — Keyframes, easing and expressions

> Read [video-projects.md](video-projects.md) for the shared project, clip, channel, timing and versioned-write contracts. Load only the sections needed for the task.

## Contents

- [Keyframe animations (per-property tracks)](#keyframe-animations-per-property-tracks)
  - [Easings](#easings)
  - [The easing catalogue](#the-easing-catalogue)
  - [Animatable tracks](#animatable-tracks)
  - [Prefixed track namespaces](#prefixed-track-namespaces)
  - [Preview timing: keys between frames](#preview-timing-keys-between-frames)
  - [Keys cut by a split (`easeSlice`)](#keys-cut-by-a-split-easeslice)
- [Hidden tracks (`hiddenPropertyKeyframes`)](#hidden-tracks-hiddenpropertykeyframes)
- [Track expressions (`propertyKeyframeFx`)](#track-expressions-propertykeyframefx)
  - [The custom expression language](#the-custom-expression-language)
  - [Looping the keyframes](#looping-the-keyframes)
  - [Glide (inertia without spring-back)](#glide-inertia-without-spring-back)
  - [Reading inside a sequence](#reading-inside-a-sequence)
- [Layer parenting and null layers (`keyframeParenting`)](#layer-parenting-and-null-layers-keyframeparenting)

### Keyframe animations (per-property tracks)

Every timeline item can animate its visual properties over the clip's duration. Each property gets its **own independent track** of keys under `propertyKeyframes` — an opacity fade on a different rhythm than a slow zoom, a rotation eased with a bounce while the scale stays smooth. Tracks are always separate; there is no merged, all-properties-per-key form.

- **`position` is 0–100, percent of the clip's played duration** (not seconds).
- **`value` is a string**: `"1.25"`, `"#ff0000"`, `"rgba(0,0,0,0.5)"`. Write strings everywhere, including progress tracks.
- **`easing`** shapes the segment **after** its key (see [Easings](#easings)).
- A **single-key track holds its value** for the whole clip.
- No two keys of one track may share a `position`; omit a track with zero keys.

```json
{
  "keyframeTransformOrigin": "center",
  "propertyKeyframes": {
    "scale":   [ { "position": 0, "value": "1", "easing": "Smooth" }, { "position": 100, "value": "1.25", "easing": "Linear" } ],
    "opacity": [ { "position": 0, "value": "0", "easing": "Ease Out" }, { "position": 20, "value": "1", "easing": "Linear" } ],
    "rotate":  [ { "position": 50, "value": "5", "easing": "Linear" } ]
  }
}
```

**Transform origin** is one item-level field, `keyframeTransformOrigin` (`"center"`, `"top"`, `"bottom"`, `"left"`, `"right"`, a corner such as `"bottom left"`, or `"x% y%"`): the point every rotation (static and keyed, 2D and 3D) and the keyed scale turn about, while `panX`/`panY`/`panZ` stay the layer's resting centre — see [Turning a flat layer in 3D](video-3d.md#turning-flat-layers-in-3d--pivot-and-stacking).

`propertyKeyframes` is baked by **`/render-onserver`** and the desktop render; the fast `/render` ignores keyframes entirely.

#### Easings

Easing names come from `GET /api/video-editor/capabilities` → `easings.keyframe.values`. **No easing carries past its key**: whatever its shape in between (including the overshooting `Back`, `Elastic` and `Overshoot` curves), the value lands exactly on the key at the key's time. For motion that continues past a key, add an expression instead — `spring` for a real spring that overshoots and settles in seconds, `glide` for a move that lands soft and keeps drifting (see [Track expressions](#track-expressions-propertykeyframefx)).

Pick the curve by intent:

| Intent | Easing |
| --- | --- |
| Cinematic move: slow start, soft stop (a good default) | `AE Smooth` |
| Arrive: up to speed early, then a long brake into the key | `AE In (arrive)` |
| Leave: a long slow start, then speeds away | `AE Out (leave)` |
| Hard decelerate: entrances, landings | `Power` — `cubic-bezier(0.23, 1, 0.32, 1)` |
| Slow wind-up, hard hit, long tail: a scene change on the beat, a logo hit, a screen swipe | `Punch` — `cubic-bezier(0.7, 0, 0.1, 1)` |
| Full speed at once, then a long soft stop: UI panels, drawers, a camera landing | `Apple Out` — `cubic-bezier(0.32, 0.72, 0, 1)` |
| Arrives fast, glides slowly through the middle, leaves fast | `Smooth Glide` — `cubic-bezier(0.2111, 0.7721, 0.8541, 0.112)` |
| Jumps in, all but stops, jumps out | `Glide Easing Stop` — `cubic-bezier(0, 0.9125, 1, -0.0338)` |
| Classic MotionFast template motion | `Natural` (punchy ease-in-out), `Slow Down` (pure decelerate), `Overshoot` (shoots past, settles slowly), `Impulse` (dips backwards before launching), `Swing` (wind-up, then a springy arrival) |
| Constant speed: progress tracks (`motionPathT`, `camPathT`), dense per-frame data | `Linear` |
| Step to the next key (a hard cut) | `Hold` |
| Your own curve | `Custom` + the key's `bezier: [x1, y1, x2, y2]` (write both together, or it falls back to `Smooth`) |

The `AE …` values are the After Effects-style bezier curves shared with MotionFast. AE names a curve by the side of the key it sits on, which is why `AE In (arrive)` brakes into its key and `AE Out (leave)` speeds away from the one before.

Aliases load and map to another name's curve (`easings.keyframe.retired`: `Power2 Out` → `Ease Out`, `Power3 Out` → `Cubic Out`, `Power4 Out` → `Power`, `Circ Out` → `Slow Down`, `Cubic Smooth` → `Natural` …). Write the names they map to.

#### The easing catalogue

`GET /api/video-editor/capabilities` → `easings` carries both vocabularies with the actual curve behind every name, so a look can be matched or carried into another tool without guessing. `easings.keyframe` covers keyframe and transition easings: `values` (all of them), `transitionValues` (the subset a transition accepts — `Custom` and `Hold` need per-key data and are rejected there), `retired` (alias → the value it maps to; accepted on load and by the API) and `curves[]`. `easings.motionTemplate` covers the camelCase names a template's ease field takes (`aeSmooth`, `power2`, …). In `curves[]`, `kind` says which field IS the curve — `bezier` → `cubicBezier` `[x1,y1,x2,y2]` plus a ready-to-paste `css`, `sampled` → `samples`, the curve at t = 0, 0.01 … 1 (values past 0..1 are real overshoot; as CSS that is `linear(<samples>)`). `gsap` names the ease that plays, and `keyframeEquivalent` / `motionTemplateEquivalent` link the same curve across the two vocabularies — only where the curves genuinely match, so treat a missing link as "these are different curves that happen to share a name" (template `smooth` is not keyframe `Smooth`; template `power2` is keyframe `Ease Out`). A `sampled` entry's `cubicBezier` (when marked `bezierIsApproximate`) is only the closest cubic — `bezierMaxError` says how far off, up to ~0.13 for `Expo Smooth`; match against the samples, not the handles. Two easings carry no curve: `Custom` reads the key's own `bezier`, and `Hold` steps to the next key.

#### Animatable tracks

A track on an item without the matching feature is a harmless no-op, and a track whose target no longer exists is dropped on load.

| Group | Tracks and units |
| --- | --- |
| Transform | `opacity` (**0–1** here; the static item field `opacity` is 0–100), `scale`, `scaleX`, `scaleY` (multipliers, 1 = unchanged, that MULTIPLY the item's base `zoom`/`scaleX`/`scaleY` — a squash-and-stretch is `scaleX` up while `scaleY` goes down), `rotate` (Z), `rotateX`, `rotateY` (degrees), `translateX`, `translateY`, `translateZ` (px), `xPercent`, `yPercent` (% of the canvas), `letterSpacing` (px), `clipPath` (%), `borderWidth` (px — the card border, or the outline on shape layers), `borderRadius` — or `borderRadiusTL`/`TR`/`BR`/`BL` while `borderRadiusLinked: false` — (the corner radius on every layer: px on media, the item's `borderRadiusUnit` on `rectangle` shapes; see [card framing](video-shapes.md#card-framing-on-every-visual-layer)) |
| Motion path | `motionPathT` (0–100 % progress), `motionPathOffsetX/Y/Z` (px from a live path), `motionPathPoints` (non-scalar: the path itself) — see [video-paths.md](video-paths.md#object-motion-paths-motionpath--motionpatht) |
| Text | `textPathSpread`, `textPathSpacing`, `textPathTrimStart`, `textPathTrimEnd`, `textPathOffsetY` ([Text on Path](video-paths.md#text-on-path-textpathenabled); no-op elsewhere), `textCounterProgress` (0–100 %, [video-text.md](video-text.md)) |
| Colour (CSS colour strings) | `color`, `backgroundColor`, `textColor` (text fill), `textBgColor` (caption bar), `textOutlineColor` (unset falls back to the text colour), `shapeFill` (a shape's background paint while its type is solid or gradient), `borderColor`. `textColor` and `shapeFill` keys may hold a CSS gradient (`linear-gradient(90deg, #fff 0%, #8b5cf6 100%)`); gradients blend stop by stop, solid↔gradient included |
| Filters | `blur` (px), `brightness`, `contrast`, `saturate` (%, 100 = neutral), `hue-rotate` (degrees), `grayscale`, `sepia`, `invert` (%, 0 = neutral), `effectAmount` (0–1), `lutAmount` (%) — each overrides the item's static `filter*` field while its track exists |
| Shape layers | `shapeWidthPx`/`shapeHeightPx` or `shapeWidthPct`/`shapeHeightPct` (the unit the shape uses; `shapeRadiusPx`/`shapeRadiusPct` on a circle), the radius tracks (under Transform) in the item's `borderRadiusUnit` on `rectangle` shapes, `backdropBlur` (px), `backdropSaturation` (%), the stroke tracks (`lineWidth`, `lineTrimStart/End/Offset`, …) and the non-scalar `shapePath` — see [video-shapes.md](video-shapes.md) |
| Layer Effects | `glowAmount` … `glowSourceLevel` (Running Glow), `depthStrength`, `depthFocus`, `glass*`, `mskAmount`, and each effect's own tracks (`mblur*`, `trail*`, `af*`, `rep*`, `ds*`, …) — listed per effect in [video-effects.md](video-effects.md#greenlight-dash--video-editor-layer-effects-and-overlay-effects) |
| Camera clips | their own registry: `camZoom`, `camX`, `camY`, `camRoll`, `camDolly`, `camTiltX`, `camTiltY`, `camPathT`, `camPathOffsetX/Y/Z`, `camFollowTarget` and the depth-of-field fields — see [video-camera.md](video-camera.md#camera-properties) |
| Playback rate | `speed` — retimes the clip rather than restyling it; see Speed curves (GreenLight Dash only) |

#### Prefixed track namespaces

These keys animate things outside the static registry, in the same `propertyKeyframes` object and with the same key shape:

| Track key | Animates | Notes |
|---|---|---|
| `fx:<eid>:<paramKey>` | An Overlay Effect numeric param, plus synthetic `mix` | `<eid>` is the effect's stable id in `item.effects`. Number params only. Running Glow / 3D Depth keep their named tracks above. See [video-effects.md](video-effects.md#greenlight-dash--video-editor-layer-effects-and-overlay-effects). |
| `mp:<paramKey>` | A **motion layer's numeric template option** (`number`/`range` field) | `<paramKey>` is the template's `fields[].key`. Which options accept a track: motion.md (GreenLight Dash only). |
| `mpc:<paramKey>` | A **motion layer's colour template option** (`color` field) | Separate prefix on purpose — a colour under `mp:` is silently dropped. |
| `gr:<key>` | A **grid layer's layout parameter** | Only the keys the current layout mode reads; see [video-grid.md](video-grid.md). |
| `rig:<pid>:<chan>` | One **Rig (Puppet) pin's pose channel** | Offsets from the pin's rest. See [video-effects.md](video-effects.md#greenlight-dash--video-editor-layer-effects-and-overlay-effects). |
| `msk:<mid>:<chan>` | One **layer mask's** geometry channel | `x`/`y`/`w`/`h`/`rot`/`feather`/`expand`/`opacity`/`grow` are numeric; **`msk:<mid>:path` is NON-SCALAR** — its value is a JSON point list, like `shapePath`. See [Layer Mask entry](video-effects.md#layer-mask-entry). |
| `txa:<aid>:<chan>` | One **text animator's** range, wiggle or effect value | `<chan>` is `start`/`end`/`offset`/`amount`/`smooth`/`easeHigh`/`easeLow` (under `drive: "time"`/`"voice"` only `amount`), `wig.max`/`wig.min`/`wig.corr`, or `<pid>.<field>` for a numeric effect field except `scramble` `rate`/`seed` and `caret` `width`/`blink`/`hideAfter`. Numeric, in the field's units. See [Advanced Animations](video-text.md#advanced-animations--effects-over-a-moving-range-of-characters-words-or-lines). |
| `ph:<n>` | One **text placeholder counter's** progress | The placeholder names its track with `kf=<n>`. See [video-text.md](video-text.md). |
| `sc:<id>:<chan>` / `scc:<id>:col` | A **3D scene rig** channel (numeric / colour) | Rig clips carry only these. See [video-3d.md](video-3d.md). |
| `px:<param>` | A **particle layer's proximity-effector parameter** | `range`, `falloff`, `depth` plus any key present in `proximity.fx`. See [video-particles.md](video-particles.md). |
| `cc:<path>` | One number of a **video/image item's `colorCorrection`** | `<path>` addresses the value inside the object: `mix`, `wb.temp`, `tone.exposure`, `levels.<rgb\|r\|g\|b>.<inB\|gamma\|inW\|outB\|outW>`, `color.saturation`, `wheels.<shadows\|midtones\|highlights>.<x\|y\|l>`, `hsl.<hue\|sat\|lum>.<0-7>`, `detail.<details\|sharpen>`. Values are clamped to the field's range. See [video-effects.md](video-effects.md#greenlight-dash--video-editor-layer-effects-and-overlay-effects). |

Tracks whose target no longer exists are dropped on load (an effect removed from the chain, a motion layer swapped to another template), with one exception: a `px:` track whose driven property has been removed from `proximity.fx` is kept, so a shaped curve survives the property being toggled off and on. Nothing reads it while the property is gone.

#### Preview timing: keys between frames

The editor evaluates every track at the exact playhead time. While playing, the preview redraws at the project's `data.previewFps` — `60` by default, or `30`, `120` or `"project"` (the project's own frame rate) — while renders always sample the export frame rate. So on a 30 fps project the preview also shows the instants **between** export frames, which no render contains:

- A key, a `Hold` step or an item end placed between export frames can look different in preview than in the render (a one-frame pop in one and not the other).
- To see exactly the frames the export will have, set `"previewFps": "project"` at the `data` root (the editor stores the field only when it is not 60), or check stills.

**Smooth cursors and hands.** Per-frame keys (a baked cursor or hand path, tracked data written as one `Linear` key per frame) are exact only at the frames they were baked for; between them the preview draws a straight line from key to key. When such a layer follows something that moves on an eased curve — a parent null, the card it points at — the eased motion is evaluated on its curve at the in-between instant while the per-frame layer cuts a straight chord, so it slips off its target between frames in preview. Hang the layer off what it follows (`keyframeParenting`) and bake its keys in that parent's space, so the eased motion comes from the parent at every instant. Where one item hands a cursor or hand over to another (one layer ends, the next takes over), give both a key at the hand-over time with the same value and place the cut on a frame boundary, so neither the preview nor the render shows a jump.

#### Keys cut by a split (`easeSlice`)

Splitting an item cuts its tracks at the split point: each half keeps its own keys, both get a key there holding the value shown at that instant, and positions are re-expressed as % of each half. Part of an easing is not itself an easing, so on each side the key that starts the cut segment keeps its `easing` and gains `easeSlice: { of, from, to, bezier? }`: the segment plays only the `from`–`to` part (fractions of the original segment) of that easing, which is what lets the two halves replay the uncut animation exactly. Copy `easeSlice` unchanged when you rewrite a track, or the halves stop matching. It applies only while `of` equals the key's `easing` (and, for `Custom`, its `bezier` equals the key's), so changing the easing switches it off; delete it to give the key the whole easing again. Do not write one yourself: it only reproduces the original curve together with the exact values the split wrote on the keys either side. A split can also add keys where an easing turns back or crosses its end value (Bounce, Elastic or Back on a shape or mask path, which clamp instead of overshooting); they belong to the same animation.

### Hidden tracks (`hiddenPropertyKeyframes`)

A track can be parked instead of deleted. `hiddenPropertyKeyframes` has the same shape as `propertyKeyframes`, and `hiddenPropertyKeyframeFx` the same shape as `propertyKeyframeFx` for those tracks. Nothing reads the hidden maps when rendering or exporting, so the layer behaves exactly as if the property had no keys, while the keys themselves survive. To hide a property, move its track (and its expression, if any) from the live maps into the hidden ones; to restore it, move both back. Keep each property in only one of the two maps, since the live track is the only one that plays. Hidden tracks are sanitized on load like live ones (orphans dropped), and both fields are omitted when empty.

```json
{
  "propertyKeyframes":         { "scale":  [ { "position": 0, "value": "1", "easing": "Smooth" }, { "position": 100, "value": "1.2", "easing": "Smooth" } ] },
  "hiddenPropertyKeyframes":   { "rotate": [ { "position": 0, "value": "0", "easing": "Linear" }, { "position": 100, "value": "90", "easing": "Linear" } ] },
  "hiddenPropertyKeyframeFx":  { "rotate": { "type": "elastic", "params": { "amp": 100, "freq": 1.1, "decay": 5 } } }
}
```

### Track expressions (`propertyKeyframeFx`)

An AE-style expression layered on top of a track's keyframed value. Stored per track in the item-level map `propertyKeyframeFx: { "<trackKey>": { "type": "...", "params": { ... } } }`; the track key must exist in `propertyKeyframes` (orphans are dropped on load) and must be **numeric** (colour and path tracks are ignored). The catalogue with parameter ranges and defaults is `GET /api/video-editor/capabilities` → `keyframeExpressions`.

```json
{
  "propertyKeyframes": { "scale": [ { "position": 0, "value": "0.4", "easing": "Smooth" }, { "position": 100, "value": "1", "easing": "Smooth" } ] },
  "propertyKeyframeFx": { "scale": { "type": "elastic", "params": { "amp": 100, "freq": 1.1, "decay": 5 } } }
}
```

`elastic`, `bounce` and `spring` **reshape the move itself** — they are not rings appended after a key. Each keyframe transition is treated as a step of size `value[i] − value[i−1]` that starts at the previous key, so the layer launches there, overshoots the target and settles into it as **one continuous motion**. So the key's own `easing` is superseded on a track carrying one of these (use `amp` to mix back toward it), and they work on the commonest track of all — two keys at 0 and 100 — where a post-key ring would have nowhere to play. `elastic` and `bounce` are normalized to each segment's own duration (the shape is identical for a 0.3 s and a 3 s move); `spring` runs in seconds instead.

- **`elastic`** (`amp` % strength 0–300, `freq` wobbles **across the move** 0.3–5, `decay` 0.5–15) — launches, crosses the target at `1/(4·freq)` of the move, overshoots by roughly `e^(−decay/(2·freq))` (a little more in practice: the defaults 100/1.1/5 overshoot ~13 % and have settled to <1 % by the key). A leftover wobble carries into the next segment as follow-through. Lower `freq` for a soft landing with a single late overshoot; raise it for a fast arrival with several wobbles.
- **`spring`** (`amp` % strength 0–300, `freq` 0.1–10 Hz, `damping` ratio 0.05–1) — a real damped spring in **seconds**, released at rest from the key before: `x = a + (b−a)·(1 − e^(−ζωt)·(cos ω_d t + ζω/ω_d·sin ω_d t))`, `ω = 2π·freq`, `ω_d = ω·√(1−ζ²)`, `t` = seconds since the move's first key. It peaks at `1 + e^(−ζπ/√(1−ζ²))` of the step and settles in ≈ `4/(ω·ζ)` s whatever the gap to the next key, so a short move and a long one ring at the same rate (Elastic stretches instead); the move's END key only says when the next step starts. A ring not settled carries into the next step. Presets (`keyframeExpressions.types[].presets`, they set `freq` + `damping` only): `snappy` 1.6 Hz / 0.55 — ~12 % overshoot, settled in 0.7 s: buttons, icons, pop-ins (the defaults); `gentle` 1 Hz / 0.8 — 1.5 % overshoot: mascots, big cards, the camera. `damping` 1 never overshoots. Leave each step ~1 s before the next key so the ring has settled. Example: `{"type":"spring","params":{"amp":100,"freq":1.6,"damping":0.55}}`.
- **`bounce`** (`amp` % strength 0–300, default 100; `elasticity` bounciness 5–80 %, default 45; `bounces` 1–10, default 5) — falls onto the target and rebounds back the way it came in decaying hops. The fall plus every hop are scaled to fit the move exactly, so it always settles **on** the key and needs no gravity or hop-duration knob. Higher bounciness spends more of the move hopping (so it lands earlier); it never passes the target.
- **`wiggle`** (`amp` 0–2000 in the property's own units — **no default: set it, or the wiggle is 0**; `freq` 0.1–20 Hz, default 3) — deterministic smooth jitter **added around** the keyed value across the whole clip (additive: the base motion stays intact), seeded per item and track so copies don't move in sync. A single-key (constant) track plus wiggle is the cheapest handheld or idle-motion recipe.
- **`glide`** (`fast` response 0.01–3 s, `slow` tail length 0.05–8 s, `weight` tail share 0–100 %, `delay` tail delay 0–3 s) — **softens** the keyed motion (its easing included): a move lands soft and keeps creeping on in the direction it travelled, never past the key and never back. See [Glide](#glide-inertia-without-spring-back).
- **`custom`** (`code`, a string ≤ 4000 chars) — your own expression; **its result becomes the property value**, so start from `value` to build on the keyframed motion. Full vocabulary in `GET /api/video-editor/capabilities` → `keyframeExpressions.customLanguage`.

Expressions ride the normal keyframe pipeline, so they render identically in preview and `/render-onserver`.

#### The custom expression language

An AE-flavoured language that the editor interprets — never `eval`s — so an expression in a shared project cannot execute code. One expression, no statements or assignment; a syntax error or non-numeric result silently leaves the keyframed value untouched.

| | |
|---|---|
| Variables | `value` (the keyframed value), `time` / `frame` / `progress` / `duration` (all **within the clip**, not the project), `fps`, `index` (the layer's channel index), `PI`, `E` |
| Operators | `+ - * / %`, `^` / `**`, unary `-`, `! < > <= >= == !=`, `&& \|\|`, `a ? b : c`, `//` and `/* */` comments |
| Math | `abs ceil floor round sqrt exp log sin cos tan asin acos atan atan2 pow min max sign hypot` — bare or as `Math.*` |
| Helpers | `clamp(v,min,max)`, `lerp(a,b,t)`, `linear(t,tMin,tMax,a,b)` (and the 3-arg `linear(t,a,b)`), `ease`/`easeIn`/`easeOut`, `degrees`/`radians` |
| Motion | `wiggle(freq, amount, octaves?)` (jitters around `value`), `noise(t, octaves?)`, `random()` / `random(max)` / `random(min,max)` |
| Loops | `loopOut(type?, numKeyframes?)`, `loopIn(…)`, `loopOutDuration(type, seconds)`, `loopInDuration(…)` — type is `cycle` (default), `pingpong`, `offset` or `continue` |
| Track | `valueAtTime(t)` — this property's own value at another clip-local time; `numKeys` |
| Glide | `glide(fast?, slow?, weight?, delay?)` — see [Glide](#glide-inertia-without-spring-back). Defaults 0.10 s / 0.6 s / 0.25 / 0 |
| Layers | `layer("Name").<trackKey>`, `thisLayer.<trackKey>`, `thisComp.layer("Name")`, and `layer("Seq").layer("Inner").<trackKey>` to read inside a sequence/grid |

`random()` and `wiggle()` are **deterministic** — seeded from the layer id and property name, so preview and every re-render agree, and two copies of a layer don't jitter in sync. Layer references read the other layer's animated value at the same instant; only layers sharing a frame with this clip can be named, and the name is the layer's custom name (or a text layer's content, else the clip name). A *real* property the target doesn't animate falls back to that layer's static value, but a name that is not a property at all is an error (`"Logo" has no property "scalevalue"`) rather than a silent 0. Mutual references stop after two hops. Division by zero yields 0 rather than Infinity.

```json
{ "propertyKeyframeFx": {
  "scale":   { "type": "custom", "params": { "code": "value + wiggle(2, 0.05)" } },
  "rotate":  { "type": "custom", "params": { "code": "loopOut(\"offset\")" } },
  "opacity": { "type": "custom", "params": { "code": "layer(\"My Sequence\").layer(\"Inner Star\").opacity" } }
} }
```

#### Looping the keyframes

`loopOut()` repeats this track's own animation past its last key — the AE function, same four types: `cycle` (start the segment again), `pingpong` (backwards, then forwards), `offset` (each pass stacked on the end of the last, so the value accumulates) and `continue` (no repeat — carry on at the end key's velocity). `loopIn(…)` mirrors it before the first key. The second argument counts keyframes of the looped segment back from the edge (`0`/omitted = the whole track, `1` = the last segment); `loopOutDuration(type, seconds)` takes seconds instead. Every type is continuous at the boundary key, so a loop never pops. Two keys plus `loopOut("pingpong")` is the cheapest infinite shuttle.

#### Glide (inertia without spring-back)

Glide replaces the "move, dead stop, move" look. It runs the track's own keyframed motion through a filter whose weights are all positive — a fast response (`fast` seconds) plus a slow tail (`slow` seconds) carrying `weight` of each move, optionally starting `delay` seconds later. A move therefore lands soft and keeps creeping on in the direction it travelled; it never passes the key and never comes back (a spring or Elastic would, and that reads as wrong-way secondary motion).

Set it as its own expression type on each track it should soften (here Floaty); put the same entry on X and Y for a 2D path:

```json
"propertyKeyframeFx": {
  "translateX": { "type": "glide", "params": { "fast": 0.1, "slow": 1, "weight": 40, "delay": 0 } },
  "translateY": { "type": "glide", "params": { "fast": 0.1, "slow": 1, "weight": 40, "delay": 0 } }
}
```

The four tuned landings (`keyframeExpressions.types[].presets`):

| Preset | `fast` / `slow` / `weight` / `delay` | Feel |
| --- | --- | --- |
| `soft` (the defaults) | 0.1 / 0.6 / 25 / 0 | lands soft and keeps sliding a little |
| `floaty` | 0.1 / 1 / 40 / 0 | a heavier tail, a longer landing |
| `trailing` | 0.1 / 0.45 / 25 / 0.1 | the last quarter of the move starts 0.1 s late, like an AE null chain |
| `endless` | 0.1 / 2 / 14 / 0 | never visibly stops before the next move |

- **Choosing the energy:** a longer `slow` and a larger `weight` mean more drift (soft → floaty → never stops). Keep `fast` near 0.1 s so most of the move still tracks its keys.
- **Glide reshapes keyed motion only:** a constant (single-key) track has nothing to glide, so give an idle layer `wiggle` instead.
- **Inside a `custom` expression** the same filter is `glide(fast, slow, weight, delay)` with `weight` as 0–1 (`glide(0.10, 1.0, 0.40)` = Floaty), for mixing into a longer expression; the two land on identical frames.
- **Camera:** key ONE framing per shot (a camera with ~100 keys per track jitters and can't be edited), give every segment a leave-fast/land-soft curve spanning the whole gap, and put `glide` on the position/dolly/zoom tracks (Endless) and the tilt/roll tracks (Floaty) — the shot never sits still and the rotation trails the move as secondary motion.
- **On a rig,** put the glide on the null's tracks: the expression is part of the null's keyed value, so every child hung off it (see [Layer parenting](#layer-parenting-and-null-layers-keyframeparenting)) inherits the same drift.
- **In and Out pass** (the editor's Glide presets): one track, `0 %` → off-frame on the entry side (`xPercent`/`yPercent` ±100) eased `Smooth Glide`, last key at **`80 %`** → ∓150 (`Linear`), plus `{"type":"glide","params":{"fast":0.1,"slow":0.6,"weight":25,"delay":0}}`. The glide tail lags in seconds, so ±100 → ∓100 at 100 % would still be on screen at the layer's end; these keys make it leave (−130…−145 % over 1.5–4 s layers) with the slow middle near the centre.

#### Reading inside a sequence

A sequence or grid layer hides its own timeline, and `.layer()` chains into it: `layer("My Sequence").layer("Inner Star").opacity`. The inner clock follows the container's placement, trim **and speed**, so the value is what that inner layer genuinely shows at this instant — a 2× sequence trimmed 1 s in resolves accordingly. Chain again for nested containers (two levels deep, then it stops).

A flat `keyframes: []` array (an all-properties-per-key shape) animates nothing: the editor and renderer read only `propertyKeyframes`, so move any animation you want to keep into it.

### Layer parenting and null layers (`keyframeParenting`)

A layer can inherit another layer's **position, rotation and scale** (PRS), After Effects style. This is how a complex move is built: put the shared motion on one parent — usually a null — and hang the layers off it. One set of keys then moves the whole group while every child keeps its own animation on top.

```json
"keyframeParenting": { "parentItemId": "<parent item id>", "type": "additive" }
```

- **`parentItemId`** is the parent's timeline item `id` (the entry in `channels[].items`), not its `clipId`: one clip can back several items, and each item moves on its own.
- **`type`** — `additive` (default): the child's own PRS (static fields, PRS tracks, its motion path) is an offset in the parent's space, so the parent's rotation and scale swing and scale that offset. A child at `panX: 20` under a parent rotated 90° with `zoom: 2` sits 40 % of the frame width straight below the parent's centre, itself rotated 90° and doubled. `full-copy`: the child takes the parent's PRS outright; its own PRS is kept but ignored.
- **Inherited:** `panX/panY/panZ`, `rotateX/rotateY/rotateZ`, `zoom`, `scaleX/scaleY`, their tracks (`translateX/Y/Z`, `xPercent/yPercent`, `rotate`, `rotateX/Y`, `scale`, `scaleX/Y`), the motion-path tracks and a live motion path. **Not inherited:** opacity, mirror, filters, effects, colours, masks, timing, and the parent's `motionFollow` (a tracked-point link). Fade or recolour a group on each child, and give every layer that should ride a motion track its own `motionFollow`.
- **Chains compose** (null → null → layer): use nested nulls to separate motions, e.g. one null travels, a child null spins, the layers hang off the spinner.
- **Same level only.** The parent is an item in the same channel list: top-level channels, or the same sequence's inner channels. A reference to a missing item, or one that closes a cycle, is dropped on load.
- **Time.** A parent is sampled at the same absolute timeline time as the child, never at the child's progress, so parent and child may start, trim and last differently. Outside its own span a parent holds its first/last pose, so give a rig's null a span that covers every child. A track's `position` is still 0–100 % of the parent clip's own duration.
- **Parentable types** (parent and child): `image`, `video`, `text`, `shape`, `motion`, `sequence`, `grid`, `adjustment`, `null`.

**Null layers** (`mediaType: "null"`) are the handle for a rig: a transform with no picture, never drawn in any render. The clip is `{ "id": "nullClip", "source": "LOCAL", "mediaType": "null", "url": "", "proxyUrl": null, "name": "Null", "duration": 6 }`. The item takes the ordinary PRS fields, `propertyKeyframes`, a `motionPath` and its own `keyframeParenting`. `nullColor` / `nullSize` only style the editor's preview marker. Effects, masks, blend, opacity and filters do nothing on a null. (The camera solve's "nulls" are shape layers instead — see tracking-data.md (GreenLight Dash only); either can be a parent.)

Orbit: two dots circle the frame centre once, upright. The null spins, and each child counter-rotates by the same amount to stay level (drop the child's `rotate` track to let it turn with the orbit).

```json
{
  "clips": [
    { "id": "cNull", "source": "LOCAL", "mediaType": "null", "url": "", "proxyUrl": null, "name": "Orbit", "duration": 6 },
    { "id": "cDot", "source": "LOCAL", "mediaType": "shape", "url": "", "proxyUrl": null, "name": "Dot", "duration": 6 }
  ],
  "channels": [
    { "id": "chNull", "name": "Orbit", "visible": true, "unsnapped": true, "items": [
      { "id": "iNull", "clipId": "cNull", "freeStart": 0, "trimStart": 0, "trimEnd": 6,
        "propertyKeyframes": { "rotate": [ { "position": 0, "value": "0", "easing": "Linear" }, { "position": 100, "value": "360", "easing": "Linear" } ] } } ] },
    { "id": "chDots", "name": "Dots", "visible": true, "unsnapped": true, "items": [
      { "id": "iDotA", "clipId": "cDot", "freeStart": 0, "trimStart": 0, "trimEnd": 6, "shapeType": "ellipse", "shapeSizeUnit": "px", "shapeWidthPx": 64, "shapeHeightPx": 64, "panX": 25,
        "keyframeParenting": { "parentItemId": "iNull", "type": "additive" },
        "propertyKeyframes": { "rotate": [ { "position": 0, "value": "0", "easing": "Linear" }, { "position": 100, "value": "-360", "easing": "Linear" } ] } } ] }
  ]
}
```

A second dot on another channel at `panX: -25` with the same parenting rides the opposite side. Scale the whole formation by keying the null's `scale`; move it by keying the null's `translateX/Y` or giving the null a `motionPath`.
