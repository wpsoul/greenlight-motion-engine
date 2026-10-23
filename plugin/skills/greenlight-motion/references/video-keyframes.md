> **GreenLight Motion Engine:** this is the GreenLight Dash Video Editor's project format, which the engine reads as is.
> Ignore the `/api/...` routes and the app UI described here: in the engine you edit `project.json` and run
> `npx greenlight-motion build`. MotionFast templates (`mediaType: "motion"`) stay in GreenLight Dash.

# GreenLight Dash — Keyframes, easing and expressions

> Read [video-projects.md](video-projects.md) for the shared project, clip, channel, timing and versioned-write contracts. Load only the sections needed for the task.

## Contents

- [Keyframe animations (per-property tracks)](video-keyframes.md#keyframe-animations-per-property-tracks)
- [Hidden tracks (`hiddenPropertyKeyframes`)](video-keyframes.md#hidden-tracks-hiddenpropertykeyframes)
- [Track expressions (`propertyKeyframeFx`)](video-keyframes.md#track-expressions-propertykeyframefx)
- [Layer parenting and null layers (`keyframeParenting`)](video-keyframes.md#layer-parenting-and-null-layers-keyframeparenting)

### Keyframe animations (per-property tracks)

Every timeline item can animate its visual properties over the clip's duration. Each property gets its **own independent track** of keys under `propertyKeyframes` — an opacity fade on a different rhythm than a slow zoom, a rotation eased with a bounce while the scale stays smooth, etc. Tracks are always separate — there is no merged, all-properties-per-key form.

Positions are always **0–100, percent of the clip's played duration** (not seconds). `value` is stored as a **string**. Easing values come from `GET /api/video-editor/capabilities` → `easings.keyframe.values` (e.g. `Linear`, `Smooth`, `Ease In`, `Ease Out`, `AE In`, `AE Smooth`, `AE Out`, `Power2 Smooth`, `Expo Out`, `Back Smooth`, `Bounce Out`, `Elastic`, …); an easing set on a key shapes the segment **after** that key. The `AE *` values are the After Effects-style bezier curves shared with MotionFast (`AE Smooth` is the classic slow-start/soft-stop AE feel — a good default for cinematic moves). Every easing still comes to a dead stop on its key. For more live energy — a move that lands soft and keeps drifting on, a shot that never sits still between keys — add the `glide` expression type on top of the track (`propertyKeyframeFx.<track> = {"type":"glide","params":{"fast":0.1,"slow":1,"weight":40,"delay":0}}`, see **Glide** under [Track expressions](video-keyframes.md#track-expressions-propertykeyframefx)). Two owner curves sit right after `Smooth`: **`Smooth Glide`** (`cubic-bezier(0.2111, 0.7721, 0.8541, 0.112)` — arrives fast, glides slowly through the middle, leaves fast) and **`Glide Easing Stop`** (`cubic-bezier(0, 0.9125, 1, -0.0338)` — jumps in, all but stops, jumps out). **In and Out pass (the Glide presets):** one track, `0 %` → off-frame on the entry side (`xPercent`/`yPercent` ±100) eased `Smooth Glide`, last key at **`80 %`** → ∓150 (`Linear`), plus `propertyKeyframeFx.<track> = {"type":"glide","params":{"fast":0.1,"slow":0.6,"weight":25,"delay":0}}` — the glide tail lags in seconds, so ±100 → ∓100 at 100 % would still be on screen at the layer's end; these keys make it leave (−130…−145 % over 1.5–4 s layers) with the slow middle near the centre. Five expressive curves from the MotionFast template catalogue are also available: `Natural` (punchy ease-in-out), `Slow Down` (pure decelerate), `Overshoot` (shoots past the target, settles slowly), `Impulse` (anticipation dip backwards before launching), and `Swing` (wind-up, then a springy arrival) — use these to reproduce classic template motion on any layer. A **single-key track holds its value constant** for the whole clip. Transform origin is one item-level field, `keyframeTransformOrigin` (`"center"`, `"top"`, `"bottom"`, `"left"`, `"right"`, a corner such as `"bottom left"`, or `"x% y%"`): the point every rotation (static and keyed, 2D and 3D) and the keyed scale turn about, while `panX`/`panY`/`panZ` stay the layer's resting centre — see [Turning a flat layer in 3D](video-3d.md#flat-layers-in-the-3d-scene--itemshadowplate).

**The easing catalogue.** `GET /api/video-editor/capabilities` → `easings` carries both vocabularies with the actual curve behind every name, so a look can be matched or carried into another tool without guessing. `easings.keyframe` covers keyframe and transition easings: `values` (all of them), `transitionValues` (the subset a transition accepts — `Custom` and `Hold` need per-key data and are rejected there), and `curves[]`. `easings.motionTemplate` covers the camelCase names a template's ease field takes (`aeSmooth`, `power2`, …). In `curves[]`, `kind` says which field IS the curve — `bezier` → `cubicBezier` `[x1,y1,x2,y2]` plus a ready-to-paste `css`, `sampled` → `samples`, the curve at t = 0, 0.01 … 1 (values past 0..1 are real overshoot; as CSS that is `linear(<samples>)`). `gsap` names the ease that plays, and `keyframeEquivalent` / `motionTemplateEquivalent` link the same curve across the two vocabularies — only where the curves genuinely match, so treat a missing link as "these are different curves that happen to share a name" (template `smooth` is not keyframe `Smooth`; template `power2` is keyframe `Ease Out`). A `sampled` entry's `cubicBezier` (when marked `bezierIsApproximate`) is only the closest cubic — `bezierMaxError` says how far off, up to ~0.19 for `Circ Out`; match against the samples, not the handles. Two easings carry no curve: `Custom` reads the key's own `bezier: [x1,y1,x2,y2]` (write both together or it falls back to Smooth), and `Hold` steps to the next key.

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

Rules: no two keys of one track may share a `position`; a track with zero keys should be omitted. One track key lives outside the registry below and is documented with the curve it replaces: **`speed`** — the clip's playback rate, which retimes the clip rather than restyling it (see [Speed curves](video-analysis.md#speed-curves-itemspeedpoints--anchors-and-tangents)). Animatable property names (the editor's `KF_PROPS` registry in `frontend/src/components/videoEditor/keyframeProps.js`): `opacity`, `scale`, `scaleX`, `scaleY`, `rotate`, `rotateX`, `rotateY`, `translateX`, `translateY`, `xPercent`, `yPercent`, `translateZ`, `motionPathT`, `motionPathOffsetX`, `motionPathOffsetY`, `motionPathOffsetZ` (px displacement from a live motion path — see [Object Motion Paths](video-paths.md#object-motion-paths-motionpath--motionpatht)), `letterSpacing`, `clipPath`, `textPathSpread`, `textPathSpacing`, `textPathTrimStart`, `textPathTrimEnd`, `textPathOffsetY` (Transform — the `textPath*` tracks animate the [Text on Path](video-paths.md#text-on-path-textpathenabled) distribution and no-op elsewhere), `borderWidth` (Transform — the card-framing border in px, the outline on shape layers); `color`, `backgroundColor` (Color — hex or rgba strings), `textColor` (text layer's fill), `textBgColor` (text layer's caption-bar colour), `textOutlineColor` (outline/stroke colour; unset falls back to the text colour), `shapeFill` (shape layer's background paint, applied while the background type is solid or gradient), `borderColor` (the border's colour) — `textColor` and `shapeFill` keys may also hold a full CSS gradient string (`linear-gradient(90deg, #fff 0%, #8b5cf6 100%)`), and the interpolator blends gradients stop-by-stop, including solid↔gradient; `blur`, `brightness`, `contrast`, `hue-rotate`, `saturate`, `grayscale`, `sepia`, `invert` (Filters — each overrides the item's static `filter*` field while its track exists); `effectAmount`; `lutAmount`; `glowAmount`, `glowEdgeLevel`, `glowLevel`, `glowRadius`, `glowAngle`, `glowEdgeWidth`, `glowOffset`, `glowStaticRim`, `glowSoftness`, `glowSpread`, `glowHeadGlint`, `glowCenterX`, `glowCenterY`, `glowTrail`, `glowFlicker`, `glowMaskThreshold`, `glowSourceLevel`, `depthStrength`, `depthFocus`, `mskAmount` (Effects — the other Layer Effects' tracks such as `mblur*`, `trail*`, `af*`, `rep*`, `ds*`, `bn*`, `cp*`, `mf*`, `bw*`, `mw*`, `dro*`, `ck*` are listed per effect in `video-effects.md`). **Camera clips keyframe a different registry** — `camZoom`, `camX`, `camY`, `camRoll`, `camDolly`, `camTiltX`, `camTiltY`, `camPathT`, `camPathOffsetX/Y/Z`, `camFollowTarget`, plus the depth-of-field fields; see the Camera layers section. `xPercent`/`yPercent` are % of canvas size, `translateX/Y/Z` are px, `scale`/`scaleX`/`scaleY` are plain multipliers (1 = unchanged) that MULTIPLY the item's base `zoom`/`scaleX`/`scaleY` — `scale` is uniform and the other two stretch one axis on top of it, so a squash-and-stretch is `scaleX` up while `scaleY` goes down, `motionPathT`/`camPathT` are 0–100 % path progress, `brightness`/`contrast`/`saturate`/`grayscale`/`sepia`/`invert` are % (100 = neutral for the first three, 0 for the rest), `blur` is px, `opacity` 0–1. A track on an item without the matching feature is a harmless no-op. `propertyKeyframes` is baked by **`/render-onserver`** (and the desktop render); the fast `/render` ignores keyframes entirely.

**Keys cut by a split carry `easeSlice`.** Splitting an item cuts its tracks at the split point: each half keeps its own keys, both get a key there holding the value shown at that instant, and positions are re-expressed as % of each half. Part of an easing is not itself an easing, so on each side the key that starts the cut segment keeps its `easing` and gains `easeSlice: { of, from, to, bezier? }`: the segment plays only the `from`–`to` part (fractions of the original segment) of that easing, which is what lets the two halves replay the uncut animation exactly. Copy `easeSlice` unchanged when you rewrite a track, or the halves stop matching. It applies only while `of` equals the key's `easing` (and, for `Custom`, its `bezier` equals the key's), so changing the easing switches it off; delete it to give the key the whole easing again. Do not write one yourself: it only reproduces the original curve together with the exact values the split wrote on the keys either side. A split can also add keys where an easing turns back or crosses its end value (Bounce, Elastic or Back on a shape or mask path, which clamp instead of overshooting); they belong to the same animation.

**Several prefixed namespaces animate things outside that static registry**, in the same `propertyKeyframes` object and with the same key shape:

| Track key | Animates | Notes |
|---|---|---|
| `fx:<eid>:<paramKey>` | An Overlay Effect numeric param, plus synthetic `mix` | `<eid>` is the effect's stable id in `item.effects`. Number params only. Running Glow / 3D Depth retain their named tracks below. See `video-effects.md`. |
| `mp:<paramKey>` | A **motion layer's numeric template option** (`number`/`range` field) | `<paramKey>` is the template's `fields[].key`. |
| `mpc:<paramKey>` | A **motion layer's colour template option** (`color` field) | Separate prefix on purpose — the interpolator picks RGBA-vs-numeric lerp from the key, so a colour under `mp:` is silently dropped. |
| `gr:<key>` | A **grid layer's layout parameter** | Only the keys the current layout mode reads; see `gridLayout.js` `GRID_KF_FIELDS`. |
| `rig:<pid>:<chan>` | One **Rig (Puppet) pin's pose channel** | Offsets from the pin's rest. See `video-effects.md`. |
| `msk:<mid>:<chan>` | One **layer mask's** geometry channel | `x`/`y`/`w`/`h`/`rot`/`feather`/`expand`/`opacity`/`grow` are numeric; **`msk:<mid>:path` is NON-SCALAR** — its value is a JSON point list, like `shapePath`. See `video-effects.md`. |
| `txa:<aid>:<chan>` | One **text animator's** range, wiggle or effect value | `<chan>` is `start`/`end`/`offset`/`amount`/`smooth`/`easeHigh`/`easeLow`, `wig.max`/`wig.min`/`wig.corr`, or `<pid>.<field>` for a numeric effect field. Numeric, in the field's units. See [Advanced Animations](video-text.md#advanced-animations--effects-over-a-moving-range-of-characters-words-or-lines). |
| `sc:<id>:<chan>` / `scc:<id>:col` | A **3D scene rig** channel (numeric / colour) | Rig clips carry only these. |
| `px:<param>` | A **particle layer's PROXIMITY EFFECTORS parameter** | `range`, `falloff`, `depth` plus any key present in `proximity.fx`. See the particle systems section. |
| `cc:<path>` | One number of a **video/image item's `colorCorrection`** | `<path>` addresses the value inside the object: `mix`, `wb.temp`, `tone.exposure`, `levels.<rgb\|r\|g\|b>.<inB\|gamma\|inW\|outB\|outW>`, `color.saturation`, `wheels.<shadows\|midtones\|highlights>.<x\|y\|l>`, `hsl.<hue\|sat\|lum>.<0-7>`. Values are clamped to the field's range. See `video-effects.md`. |

Tracks whose target no longer exists are dropped on load (an effect removed from the chain, a motion layer swapped to another template) — with one deliberate exception: a `px:` track whose driven property has been removed from `proximity.fx` is KEPT, because `fx` entries are added and dropped from a dropdown constantly and a shaped curve must survive that. Nothing reads it while the property is gone. See the Motion layers section for which options accept an `mp:`/`mpc:` track.

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

An AE-style expression layered on top of a track's keyframed value. Stored per track in the item-level map `propertyKeyframeFx: { "<trackKey>": { "type": "...", "params": { ... } } }`; the track key must exist in `propertyKeyframes` (orphans are dropped on load) and must be **numeric** (color and path tracks are ignored). The catalog with parameter ranges/defaults is published at `GET /api/video-editor/capabilities` → `keyframeExpressions`.

```json
{
  "propertyKeyframes": { "scale": [ { "position": 0, "value": "0.4", "easing": "Smooth" }, { "position": 100, "value": "1", "easing": "Smooth" } ] },
  "propertyKeyframeFx": { "scale": { "type": "elastic", "params": { "amp": 100, "freq": 1.1, "decay": 5 } } }
}
```

`elastic` and `bounce` **reshape the move itself** — they are not rings appended after a key. Each keyframe transition is treated as a step of size `value[i] − value[i−1]` and replayed through a profile normalized to that segment's own duration, so the layer launches at the previous key, overshoots the target and settles into it as **one continuous motion**. Consequences worth knowing: the key's own `easing` is superseded on a track carrying one of these (use `amp` to mix back toward it), the shape is identical for a 0.3s and a 3s move, and it works on the commonest track of all — two keys at 0 and 100 — where a post-key ring would have nowhere to play.

- **`elastic`** (`amp` % strength 0–300, `freq` wobbles **across the move** 0.3–5, `decay` 0.5–15) — launches, crosses the target at `1/(4·freq)` of the move, overshoots by ≈`e^(−decay/(2·freq))`, then wobbles in. Defaults (100/1.1/5) give a ~13% overshoot that has settled to <1% by the key. A leftover wobble carries into the next segment as follow-through. Lower `freq` for a soft landing with a single late overshoot; raise it for a fast arrival with several wobbles.
- **`bounce`** (`amp` % strength, `elasticity` bounciness 5–80%, `bounces` 1–10) — falls onto the target and rebounds back the way it came in decaying hops. Self-normalizing: the fall plus every hop are scaled to fit the move exactly, so it always settles **on** the key and needs no gravity or hop-duration knob. Higher bounciness spends more of the move hopping (so it lands earlier); it never passes the target.
- **`wiggle`** (`amp` in the property's own units, `freq` Hz) — deterministic smooth jitter **added around** the keyed value across the whole clip (this one is additive and leaves the base motion intact), seeded per item+track so copies don't move in sync. A single-key (constant) track plus wiggle is the cheapest "handheld"/idle-motion recipe.
- **`glide`** (`fast` response 0.01–3 s, `slow` tail length 0.05–8 s, `weight` tail share 0–100 %, `delay` tail delay 0–3 s) — **softens** the keyed motion (its easing included): a move lands soft and keeps creeping on in the direction it travelled, never past the key and never back. Presets (also in `keyframeExpressions.types[].presets`): `soft` 0.1/0.6/25/0 (the defaults), `floaty` 0.1/1/40/0, `trailing` 0.1/0.45/25/0.1, `endless` 0.1/2/14/0. Same filter as `glide()` in a custom expression. See **Glide** below.
- **`custom`** (`code`, a string ≤4000 chars) — your own expression; **its result becomes the property value**, so start from `value` to build on the keyframed motion. Full vocabulary in `GET /api/video-editor/capabilities` → `keyframeExpressions.customLanguage`.

**The custom expression language.** An AE-flavoured language, *interpreted* by `keyframeExpr.js` — never `eval`'d, so an expression in a shared project cannot execute code. One expression, no statements or assignment; a syntax error or non-numeric result silently leaves the keyframed value untouched (and the panel shows why).

| | |
|---|---|
| Variables | `value` (the keyframed value), `time` / `frame` / `progress` / `duration` (all **within the clip**, not the project), `fps`, `index`, `PI`, `E` |
| Operators | `+ - * / %`, `^` / `**`, unary `-`, `! < > <= >= == !=`, `&& \|\|`, `a ? b : c`, `//` and `/* */` comments |
| Math | `abs ceil floor round sqrt exp log sin cos tan asin acos atan atan2 pow min max sign hypot` — bare or as `Math.*` |
| Helpers | `clamp(v,min,max)`, `lerp(a,b,t)`, `linear(t,tMin,tMax,a,b)` (and the 3-arg `linear(t,a,b)`), `ease`/`easeIn`/`easeOut`, `degrees`/`radians` |
| Motion | `wiggle(freq, amount, octaves?)` (jitters around `value`), `noise(t, octaves?)`, `random()` / `random(max)` / `random(min,max)` |
| Loops | `loopOut(type?, numKeyframes?)`, `loopIn(…)`, `loopOutDuration(type, seconds)`, `loopInDuration(…)` — type is `cycle` (default), `pingpong`, `offset` or `continue` |
| Track | `valueAtTime(t)` — this property's own value at another clip-local time; `numKeys` |
| Glide | `glide(fast?, slow?, weight?, delay?)` — soft landing that keeps creeping on in the move's direction (never past the key, never back). Defaults 0.10 s / 0.6 s / 0.25 / 0 |
| Layers | `layer("Name").<trackKey>`, `thisLayer.<trackKey>`, `thisComp.layer("Name")`, and `layer("Seq").layer("Inner").<trackKey>` to read inside a sequence/grid |

`random()` and `wiggle()` are **deterministic** — seeded from the layer id and property name, so preview and every re-render agree, and two copies of a layer don't jitter in sync. Layer references read the other layer's animated value at the same instant; only layers sharing a frame with this clip can be named, and the name is the layer's custom name (or a text layer's content, else the clip name). A *real* property the target doesn't animate falls back to that layer's static value, but a name that is not a property at all is an error (`"Logo" has no property "scalevalue"`) rather than a silent 0. Mutual references stop after two hops. Division by zero yields 0 rather than Infinity.

**Looping the keyframes.** `loopOut()` repeats this track's own animation past its last key — the AE function, same four types: `cycle` (start the segment again), `pingpong` (backwards, then forwards), `offset` (each pass stacked on the end of the last, so the value accumulates) and `continue` (no repeat — carry on at the end key's velocity). `loopIn(…)` mirrors it before the first key. The second argument counts keyframes of the looped segment back from the edge (`0`/omitted = the whole track, `1` = the last segment); `loopOutDuration(type, seconds)` takes seconds instead. Every type is continuous at the boundary key, so a loop never pops. Two keys plus `loopOut("pingpong")` is the cheapest infinite shuttle.

**Glide (inertia without spring-back).** `glide()` replaces the "move, dead stop, move" look: it runs this track's own keyframed motion through a filter whose weights are all positive — a fast response (`fast` seconds) plus a slow tail (`slow` seconds) carrying `weight` of each move, optionally starting `delay` seconds later. So a move lands soft and keeps creeping on in the direction it travelled; it never passes the key and never comes back (a spring or Elastic would, and reads as a wrong-way secondary motion). The **Glide** type's preset tags are the four tuned landings: **Soft** (0.10 s / 0.6 s / 25 %), **Floaty** (0.10 / 1.0 / 40 %), **Trailing** (0.10 / 0.45 / 25 %, tail 0.10 s late — the last quarter starts later, like an AE null chain) and **Endless** (0.10 / 2.0 / 14 %, never stops). Put the same call on X and Y for a 2D path. **Camera:** key ONE framing per shot (not a key per drift — a camera with ~100 keys per track jitters and can't be edited), give every segment a leave-fast/land-soft curve spanning the whole gap, and put `glide` on the position/dolly/zoom tracks (Endless) and the tilt/roll tracks (Floaty) — the shot never sits still and the rotation trails the move as secondary motion.

Glide is its own expression type, set on each track it should soften (here Floaty):

```json
"propertyKeyframeFx": {
  "translateX": { "type": "glide", "params": { "fast": 0.1, "slow": 1, "weight": 40, "delay": 0 } },
  "translateY": { "type": "glide", "params": { "fast": 0.1, "slow": 1, "weight": 40, "delay": 0 } }
}
```

Inside a `custom` expression the same filter is `glide(fast, slow, weight, delay)` with `weight` as 0–1 (`glide(0.10, 1.0, 0.40)` = Floaty), for mixing into a longer expression; the two land on identical frames.

Choosing the energy: a longer `slow` and a larger `weight` mean more drift (soft → floaty → never stops); keep `fast` near 0.1 s so most of the move still tracks its keys. Glide reshapes keyed motion only — a constant (single-key) track has nothing to glide, so give an idle layer `wiggle` instead. On a rig, put the glide on the null's tracks: the expression is part of the null's keyed value, so every child hung off it (see [Layer parenting](video-keyframes.md#layer-parenting-and-null-layers-keyframeparenting)) inherits the same drift.

**Reading inside a sequence.** A sequence or grid layer hides its own timeline, and `.layer()` chains into it: `layer("My Sequence").layer("Inner Star").opacity`. The inner clock follows the container's placement, trim **and speed**, so the value is what that inner layer genuinely shows at this instant — a 2× sequence trimmed 1s in resolves accordingly. Chain again for nested containers (two levels deep, then it stops).

```json
{ "propertyKeyframeFx": {
  "scale":   { "type": "custom", "params": { "code": "value + wiggle(2, 0.05)" } },
  "rotate":  { "type": "custom", "params": { "code": "loopOut(\"offset\")" } },
  "opacity": { "type": "custom", "params": { "code": "layer(\"My Sequence\").layer(\"Inner Star\").opacity" } }
} }
```

In the editor these live behind the small **ƒx** button next to each property row's name in the Keyframes panel; Custom adds a textarea with an **Insert** picker that drops variables, functions and the keyframed properties of every overlapping layer at the caret. Expressions ride the normal keyframe pipeline, so they render identically in preview and `/render-onserver`.

> Legacy note: older projects may still carry a flat `keyframes: []` array (the retired "all-properties-per-key" shape). The current editor and renderer read **only** `propertyKeyframes`; a bare `keyframes` array no longer animates. When editing an old project, move any animation you want to keep into `propertyKeyframes`.

### Layer parenting and null layers (`keyframeParenting`)

A layer can inherit another layer's **position, rotation and scale** (PRS), After Effects style. This is how a complex move is built: put the shared motion on one parent — usually a null — and hang the layers off it. One set of keys then moves the whole group while every child keeps its own animation on top.

```json
"keyframeParenting": { "parentItemId": "<parent item id>", "type": "additive" }
```

- **`parentItemId`** is the parent's timeline item `id` (the entry in `channels[].items`), not its `clipId`: one clip can back several items, and each item moves on its own.
- **`type`** — `additive` (default): the child's own PRS (static fields, PRS tracks, its motion path) is an offset in the parent's space, so the parent's rotation and scale swing and scale that offset. A child at `panX: 20` under a parent rotated 90° with `zoom: 2` sits 40 % of the frame width straight below the parent's centre, itself rotated 90° and doubled. `full-copy`: the child takes the parent's PRS outright; its own PRS is kept but ignored.
- **Inherited:** `panX/panY/panZ`, `rotateX/rotateY/rotateZ`, `zoom`, `scaleX/scaleY`, their tracks (`translateX/Y/Z`, `xPercent/yPercent`, `rotate`, `rotateX/Y`, `scale`, `scaleX/Y`) and a live motion path. **Not inherited:** opacity, mirror, filters, effects, colours, masks, timing, and the parent's `motionFollow` (a tracked-point link). Fade or recolour a group on each child, and give every layer that should ride a motion track its own `motionFollow`.
- **Chains compose** (null → null → layer): use nested nulls to separate motions, e.g. one null travels, a child null spins, the layers hang off the spinner.
- **Same level only.** The parent is an item in the same channel list: top-level channels, or the same sequence's inner channels. A reference to a missing item, or one that closes a cycle, is dropped on load.
- **Time.** A parent is sampled at the same absolute timeline time as the child, never at the child's progress, so parent and child may start, trim and last differently. Outside its own span a parent holds its first/last pose, so give a rig's null a span that covers every child. A track's `position` is still 0–100 % of the parent clip's own duration.
- **Parentable types** (parent and child): `image`, `video`, `text`, `shape`, `motion`, `sequence`, `grid`, `adjustment`, `null`.

**Null layers** (`mediaType: "null"`) are the handle for a rig: a transform with no picture, never drawn in any render. The clip is `{ "id": "nullClip", "source": "LOCAL", "mediaType": "null", "url": "", "proxyUrl": null, "name": "Null", "duration": 6 }`. The item takes the ordinary PRS fields, `propertyKeyframes`, a `motionPath` and its own `keyframeParenting`. `nullColor` / `nullSize` only style the editor's preview marker. Effects, masks, blend, opacity and filters do nothing on a null.

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
      { "id": "iDotA", "clipId": "cDot", "freeStart": 0, "trimStart": 0, "trimEnd": 6, "shapeType": "ellipse", "shapeWidthPct": 6, "shapeHeightPct": 6, "panX": 25,
        "keyframeParenting": { "parentItemId": "iNull", "type": "additive" },
        "propertyKeyframes": { "rotate": [ { "position": 0, "value": "0", "easing": "Linear" }, { "position": 100, "value": "-360", "easing": "Linear" } ] } } ] }
  ]
}
```

A second dot on another channel at `panX: -25` with the same parenting rides the opposite side. Scale the whole formation by keying the null's `scale`; move it by keying the null's `translateX/Y` or giving the null a `motionPath`.
