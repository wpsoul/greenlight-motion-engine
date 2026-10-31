> **GreenLight Motion Engine:** this is the GreenLight Dash Video Editor's project format, which the engine reads as is.
> Ignore the `/api/...` routes and the app UI described here: in the engine you edit `project.json` (or `apply`) and run
> `npx greenlight-motion build`; what `GET /api/video-editor/capabilities` returns there is `npx greenlight-motion schema <topic>`
> here. `frontend/src/…` paths are files of the engine's public source repository. MotionFast templates (`mediaType: "motion"`)
> stay in GreenLight Dash.

# GreenLight Dash — Video Editor Layer Effects and Overlay Effects

> Part of the `greenlight-dash` skill. Read `video-projects.md` first for the project, clip, channel, item, timing and versioned-write contracts; read [video-keyframes.md](video-keyframes.md) when animating effects.

## Contents

- [Preferred and avoided effects](#preferred-and-avoided-effects)
- [Shockwave only on request](#shockwave-only-on-request)
- [Effects in an intro](#effects-in-an-intro)
- [One effect for many small layers](#one-effect-for-many-small-layers)
- [Storage contract](#storage-contract)
- [Overlay Effects (`item.effects`)](#overlay-effects-itemeffects)
  - [Overlay Effect entry](#overlay-effect-entry)
  - [Current effect registry](#current-effect-registry)
  - [Regular-layer Overlay Effects example](#regular-layer-overlay-effects-example)
  - [Adjustment-layer Overlay Effects example](#adjustment-layer-overlay-effects-example)
  - [Overlay Effect keyframes](#overlay-effect-keyframes)
  - [Custom Overlay Effect (GLSL)](#custom-overlay-effect-glsl)
- [Layer Effects (`item.layerEffects`)](#layer-effects-itemlayereffects)
  - [Running Glow entry](#running-glow-entry)
  - [Build Depth Map entry](#build-depth-map-entry)
  - [3D Depth entry](#3d-depth-entry)
  - [Depth Scan entry](#depth-scan-entry)
  - [Motion Blur entry](#motion-blur-entry)
  - [Posterize Time entry](#posterize-time-entry)
  - [Motion Trail entry](#motion-trail-entry)
  - [Grow Fill entry](#grow-fill-entry)
  - [Rig (Puppet) entry](#rig-puppet-entry)
  - [Repetile entry](#repetile-entry)
  - [Region Distort entry](#region-distort-entry)
  - [Bend entry](#bend-entry)
  - [Corner Pin entry](#corner-pin-entry)
  - [Mesh Warp entry](#mesh-warp-entry)
  - [Bezier Warp entry](#bezier-warp-entry)
  - [Droste entry](#droste-entry)
  - [Glass entry](#glass-entry)
  - [Chroma Key entry](#chroma-key-entry)
  - [Layer Mask entry](#layer-mask-entry)
  - [Mockup Frame entry](#mockup-frame-entry)
  - [Complete regular-item example](#complete-regular-item-example)
- [Adjustment-layer LUT](#adjustment-layer-lut)
- [Color Correction (`item.colorCorrection`)](#color-correction-itemcolorcorrection)
- [Render and editing rules](#render-and-editing-rules)

## Preferred and avoided effects

When the user has not named an effect, choose from these first:

- Overlay Effects (`effects[].id`): `ascii`, `bloom`, `colorama`, `crtMatrix`, `doubleExposure`, `echo`, `edgeDetect`, `extract`, `fastBlur`, `fastCameraWiggle`, `fill`, `filmStock`, `gradientBeam`, `gradientSweep`, `halftone`, `lightRays`, `pixelate`, `radialFastBlur`, `rgbSplit`, `shapeRulers`, `timeshift`.
- Layer Effects (`layerEffects[]`): `runningGlow`, `motionBlur`, `motionTrail`, `autoFill`, `repetile`, `regionDistort`, `cornerPin`, `rig`, `droste`, `glass`, `chromaKey`, `layerMask`.

Leave these out unless the user asks for them: `grain` (Film Grain), `lensPrism`, `linesDraw`, `sdfLensBlur`.

A preferred effect still has to suit the shot: use one only when the shot calls for it, never because it is on this list. The rules below (Shockwave only on request, no turbulence in an intro) still apply.

## Shockwave only on request

Do not add the `shockwave` Overlay Effect (an `effects[]` entry with `id: "shockwave"`) unless the user asks for a shockwave. It is a stock template move that viewers recognise at once, and its ripple smears whatever sits under it, so one added unasked makes the edit look generic. To accent an impact or a beat, use eased scale/position/opacity keyframes or a layer transition instead.

## Effects in an intro

Keep Shockwave and turbulence distortions out of intro animations (the opening title, a logo reveal, the first shot of a film). That means the `shockwave` Overlay Effect, `turbulentDisplace`, `vectorFieldWarp` with `turbulence` above 0, and particle systems built on the `shockwave` preset, a `burst` force emitter or a strong `forces.turbulence`. The intro is where the viewer reads the name and forms a first impression. A ripple or noise warp smears those letters while they are being read, and viewers know it as a stock template move, so the opening looks generic instead of designed. Build the entrance from clean motion: layer transitions (`transitionInType`, see [video-transitions.md](video-transitions.md)), eased position/scale/opacity keyframes, masks and wipes, blur-to-sharp, text reveal presets. Later in a film these effects are fine when the user asks for them or the content calls for one (heat haze, water, an impact on a beat); the `shockwave` Overlay Effect still waits for the user to ask (see [Shockwave only on request](#shockwave-only-on-request)).

## One effect for many small layers

When many small layers make up one object — the lines and dots of a plexus, the bars of an equaliser, shapes standing in for particles, the pieces of an icon — and they all need the same Overlay Effect (a glow, a blur, a bloom), apply that effect once, with an adjustment item, instead of copying it onto every layer.

**Why:** a layer with its own `effects` is drawn alone into a full-frame buffer, and each effect then runs over the whole frame. The cost grows with the number of layers, not with how many pixels they cover. In one measured project, 36 thin lines each carrying its own `glow` rendered about 7× slower than the same lines with none. One adjustment glow costs about as much as one of those layers.

**How:**

1. Move the layers into one `sequence` clip (see [Sequence clips](video-projects.md#sequence-clips-mediatype-sequence)). Clear their `effects` and keep everything else (keyframes, timing, channel order).
2. Add an `adjustment` channel as the last (topmost) entry of that sequence's `channels`, carrying the single effect. Give it a window that covers the layers.
3. Put the sequence item where the layers used to be.

An adjustment item processes every channel below it at its level. Inside the group it sees only the group, which renders over transparency. A background or other layers under the group stay untouched. Put the adjustment at the top level only when everything below it, backgrounds included, should get the effect.

```json
{
  "id": "plexus-seq", "source": "LOCAL", "mediaType": "sequence", "url": "", "proxyUrl": null, "name": "Plexus", "duration": 1.05,
  "sequence": {
    "clips": ["…the line/dot shape clips…",
      { "id": "plexus-glow-clip", "source": "LOCAL", "mediaType": "adjustment", "url": "", "proxyUrl": null, "name": "Plexus glow", "duration": 1.05 }],
    "channels": ["…the line/dot channels, effects: [] …",
      { "id": "plexus-glow-ch", "name": "Plexus glow", "visible": true, "unsnapped": true,
        "items": [{ "id": "plexus-glow", "clipId": "plexus-glow-clip", "freeStart": 0, "trimStart": 0, "trimEnd": 1.05,
          "effects": [{ "id": "glow", "eid": "plexus-glow-g", "enabled": true, "mix": 100,
            "params": { "intensity": 0.85, "threshold": 0.05, "radius": 13, "color": "#33EFAB" } }] }] }]
  }
}
```

One glow over the composite reads slightly differently from many. Per-layer glows add up wherever layers overlap; one glow over the composite does not. When converting an existing look, compare composited stills and raise `intensity` (or keyframe `fx:<eid>:intensity`) for the stretch where the layers lie on top of each other.

## Storage contract

The product has two distinct effect sections. Do not infer the field from the selected clip type:

| Product panel | Item field | Items | Meaning |
|---|---|---|---|
| **Overlay Effects** | `effects` | regular visual items **and** adjustment items | ordered GPU-effect chain |
| **Layer Effects** | `layerEffects` | regular visual items (+ `layerMask` on adjustment items) | typed structural effects: Running Glow, Motion Blur, Grow Fill, Rig (Puppet), Repetile, Region Distort, Bend, Corner Pin, Droste, Chroma Key, Layer Mask, plus the Depth trio (`depthMap` / `depth3d` / `depthScan`, authored from the DEPTH EFFECTS section) |

`effects` uses the same entry schema everywhere. The item type determines the input:

- On a regular visual item, Overlay Effects process that isolated layer and follow its transform. `clip` controls whether output is cut back to its silhouette.
- On a regular visual item with a transition, the render order is **source layer → Overlay Effects → transition → composite**. Outgoing and incoming clips are effected independently before the transition combines or moves them.
- On an adjustment item, Overlay Effects process the composited channels below the adjustment channel. The coordinate space is the full frame.

`layerEffects` is **not** the Overlay Effects registry. It contains the Layer Effects panel entries described later in this file.

Do not write the obsolete direct fields `glowEnabled`, `glow*`, `depthEnabled`, `depth*`, or `depthMap`. They are not loaded. Running Glow and 3D Depth data belongs inside `layerEffects` entries. Neon Glow (`neonGlow`) is an OVERLAY effect (`item.effects`); a legacy `layerEffects` entry for it migrates automatically on load.

## Overlay Effects (`item.effects`)

The chain:

- contains at most **4** entries;
- runs in array order;
- renders in preview, WebCodecs export, sequences, and `/render-onserver`;
- supports stable instance ids, Mix, parameters, active ranges, custom GLSL, and keyframes;
- drops unknown effect ids on load.

### Overlay Effect entry

```json
{
  "id": "glow",
  "eid": "overlay-glow-1",
  "enabled": true,
  "mix": 100,
  "params": {
    "intensity": 1.1,
    "threshold": 0.55,
    "radius": 26,
    "color": "#ffffff"
  },
  "start": 0.5,
  "end": 2.75,
  "clip": false
}
```

- `id` selects the registered effect.
- `eid` is stable and unique within the item. Never change it while editing or reordering because keyframe tracks reference it.
- `enabled` defaults to true; false preserves settings but bypasses the entry.
- `mix` is 0–100; 0 is an exact bypass.
- `params` contains effect-specific values. Preserve keys you are not intentionally changing.
- Optional `start` / `end` are clip-local seconds. Omit both for the whole clip.
- Optional `clip` is meaningful when `effects` is on a regular layer: true cuts output to the layer silhouette, false allows bloom/blur/displacement outside it. Omit it for the registry default.
- `code` is accepted only for `id: "custom"` and is capped at 8192 characters.
- Optional `real3d: true` — on a `model3d` item only: the effect renders INSIDE the model's 3D pass instead of on its flat picture (see **Real 3D on 3D model layers** below). Write it only when true; an entry without it keeps the flat version, which is how every project saved before it still looks.

Numeric params are clamped to registry ranges. Colors use CSS color strings, selects use numeric option values, `type: "easing"` params use one of their `options` easing names (an unknown name falls back to the default), gradients use CSS gradient strings, and the Curves effect's `curves` param is a four-channel point-list object (see Curves below).

### Current effect registry

Before creating or editing `effects` or `layerEffects`, call:

```http
GET /api/video-editor/capabilities
```

- `effects.overlay[]` contains every Overlay Effect with its `id`, name, group, supported `scopes`, `defaultClip`, complete `defaultParams`, parameter types/ranges/options, and per-parameter `keyframable` flag.
- `effects.layer[]` contains every typed Layer Effect with defaults, fields, supported media types, requirements, and PRO status.
- `effects.limits.overlayEffectsPerItem` is the current chain limit.

Use `params: {}` for registry defaults, or start from `defaultParams` and change only requested values. Never invent an id, parameter key, select value, range, scope, or keyframe capability from this document; the runtime-generated endpoint is authoritative.

Glass is not an Overlay Effect: an Overlay Effect only restyles its own layer, while glass has to bend the layers behind it. It is the `glass` Layer Effect on a shape — see [Glass entry](#glass-entry).

#### Gradient Motion Beam type

`gradientBeam.params.type` selects how the existing effect travels:

- `0` — **Directional** (default): the original edge-to-edge sweep. `angle` controls its direction.
- `1` — **From Center**: an expanding radial beam. Its origin is the full view center on an adjustment item and the layer's own center on a regular item; `angle` is ignored.

Existing entries that omit `type` remain Directional. Both types share the same palette, speed, blur, width, hold, intensity, blend mode, and frost parameters.

`gradientBeam.params.layerMask` (0–100 %, default `100`, keyframable) shows the original layer outside the beam. At `100` the layer is untouched (the behaviour of every entry that omits it). At `0` the beam is the layer's mask: the layer is visible only where the beam passes, so a sweep becomes a travelling reveal. Coverage follows the beam's shape (`width`, `blur`, `hold`, `speed`), not `opacity` — an `opacity` of `0` with `layerMask: 0` is a pure reveal with no colour cast. Leave `clip` unset (the effect clips to the layer's shape by default) so the mask follows the silhouette. Overlay `mix` still crossfades the whole effect, mask included.

#### Gradient Sweep

`gradientSweep` (**Gradient Sweep**, group Gradient, both scopes, **PRO** — free to preview, gated at render like Neon Glow) sweeps one light band with a 5-stop palette ramp across the layer's alpha — the Gradient Sweep Text motion template generalised to any layer. `params.mode` selects what the band does:

- `0` — **Reveal** (default): ahead of the band the layer is hidden and defocused (`leadBlur`); the band paints it with the palette; behind it the real pixels settle in, trailed by a cooled edge outline (`strokeWidth`/`strokeOpacity`/`strokeFade`, colour `strokeColor`) that dissolves after the pass.
- `1` — **Silhouette**: the text template's look on any alpha — band + faint `coolFill` interior + outline; the layer's own pixels are never shown, and everything fades out after the pass.
- `2` — **Sheen**: the layer stays visible; the band crosses it as a glare (`blend`: `0` Add / `1` Screen / `2` Normal). `dimOutside` darkens the layer away from the band, easing on/off over `sheenFade` seconds, timed so full opacity returns exactly when the band lands.

Timing is a pure function of the clip-local clock: the sweep starts at the clip start (or at the entry's Active Range `start`, which rebases the clock) and crosses in `duration` seconds with `easing` (`0` Sine / `1` Linear / `2` Smooth / `3` Ease Out). `loop: 1` repeats with `loopGap` seconds of rest. `angle` is −180…180° (direction and tilt in one), `bandWidth`/`coreWidth` size the ramp, `bandStrength` scales it, `glow`/`glowRadius` add bloom that spreads past the silhouette (the effect defaults to **not** clipping — leave `clip` unset). Palette: `colorCore`/`colorWarm`/`colorHot`/`colorCool`/`colorDeep`. On an adjustment item the band sweeps the full frame and Reveal uncovers the whole below-stack.

#### Fractal Noise

`fractalNoise` (**Fractal Noise**, group Pattern, both scopes, free) is the After Effects Fractal Noise analogue: one looping noise field painted over the item — fog, smoke, cloud, light leaks, film wash and heat haze from one algorithm. A fresh entry IS the Drifting Fog preset (Basic, 4 octaves, floor 0.35, drift 0.25, Screen). `params.type` picks the fractal: `0` Basic (default; the plain rolling field) / `1` Turbulent (zero crossings fold into creases) / `2` Ridged (the fold inverted into bright filaments; `ridge` sharpens them). `colorShadow`/`colorLight` tint the field.

Shape: `scale` (15–600 %, feature size), `stretch` (−2…2, negative = vertical streamers), `rotation`, `octaves` (Complexity, 1–8), `gain` (Sub Influence), `subRot` (Sub Rotation). `soft` (Crease Softness) rounds the Turbulent/Ridged creases — 0 is the hard sharp fold, higher values give smooth billows. The four cloud controls: `mass` (Mass Detail) keeps fine texture inside the dense masses and leaves the thin gaps smooth; `edge` (Edge Softness) dissolves the outlines so no puff shows a detailed rim; `wisp` (Wisp Warp) bends the field into advected streaks; `density` fills the cores like optical extinction. `light` (Lighting) shades the low-octave lumps from `lightAngle` so they read as volume.

Motion: `churn` is whole turns of the evolution loop per clip (fractional values allowed) — a whole number loops seam-free across the clip (or the entry's Active Range); `driftSpeed`/`driftAngle` pan the field linearly over time. Levels: `contrast`, `brightness`, `floor` (values below it vanish — the fog trick with Screen), `invert`.

Composite: `blend` `0` Screen (default) / `1` Add / `2` Multiply / `3` Overlay / `4` Soft Light / `5` **Over (field = alpha)** — the field is a cloud body composited in front of the item, so dense cores occlude it. `maskLayer: 1` (Mask Layer by Noise) multiplies the item's alpha by the field: only the noise stays visible and the empty areas of the layer become transparent — combine with Over on a solid to make a free-floating cloud layer. Overlay `mix` is the opacity. The effect clips to the item's shape by default; set `clip: false` on an Over-blend entry to let the cloud spill past the silhouette.

Presets (the panel's chips, all params + colours in one click): Drifting Fog, Rolling Smoke, Smoke Veins, Cloud Bed, Light Leak, Film Wash, Heat Veil.

#### Bloom

`bloom` (**Bloom**, group Glow, both scopes) makes bright content leak light — a physically-shaped glow built on an octave pyramid rather than a blur kernel. `threshold` (0–1) with `knee` (soft shoulder) picks what counts as bright; `intensity` (0–600 %) scales the leak; `radius` (1–4) is **octaves of spread, not pixels** — 1 is a tight halo, 4 folds in a sixteenth-resolution octave whose halos span hundreds of px, and fractional values morph continuously. `saturation` desaturates or over-saturates the leaked light only, `tint` + `tintAmount` recolour it (the classic cold anamorphic look is a blue tint at ~60 %), and `blend` composites `0` Add / `1` Screen (protects already-bright frames from clipping) / `2` Lighten (max — halos never stack past the glow itself) / `3` Color Dodge (punchy filmic burn; falls back to Add over transparency so the outside halo survives) / `4` Bloom Only (just the leaked light, alpha from the bloom energy — for compositing the glow on its own). `anamorphic` (−100…100 %) smears the bloom into wide lens streaks — positive horizontal, negative vertical; magnitude sets streak length. `0` disables that pass entirely. It writes outside the silhouette by design; leave `clip` unset. On an adjustment item it blooms the whole below-stack — the usual "cinematic glow" move is an adjustment layer with `threshold` ~0.7 so only real highlights leak. Differs from `glow`: `glow` is a single-radius Gaussian with a colour; `bloom` is multi-scale, energy-conserving, and holds its shape at any radius.

#### Echo

`echo` (**Echo**, group Motion, both scopes) is After Effects' Echo: the same image sampled at several times and folded together. It is the chain's only **temporal** effect — the one entry whose output depends on frames other than the one being drawn.

`engine` picks where the extra images come from, and the choice is a real trade, not a quality setting:

- `0` — **Frame History** (default): a ring of plates recorded as they go past, so each image is what was *really* on screen then. This is the only engine that carries motion from INSIDE the content — a video, a talking head, per-glyph text animation, or an entire below-stack under an adjustment item. It can only reach into the PAST, lands on a nominal 30fps grid, stores its plates at reduced resolution, and reaches back only as far as the ring holds (`capacity` frames ÷ 30 seconds).
- `1` — **Analytic**: the current plate re-posed at each echo time through the layer's own transform. Exact at any instant, so sub-frame `echoTime` values are honoured, a POSITIVE `echoTime` works (echoes that *lead* the layer), and there is no capacity ceiling and no seek cost. It moves current pixels, so it cannot show internal motion. It needs a layer box: on an **adjustment item it falls back to Frame History**, because "everything below" has no single pose.

A Frame History tap with no recording — a fresh seek, a positive `echoTime`, or a stack longer than the ring — falls back to the Analytic reprojection rather than dropping out, so a scrubbed frame stays usable and fills in as playback or an export runs forward. Frames before the clip start contribute nothing, exactly as in AE, so a trailing echo grows in over the first moments of a clip rather than being clipped flat.

Parameters follow AE's names and sign convention: `echoTime` in seconds, **negative trails behind, positive leads** (default −0.0333, one frame at 30fps); `count` echoes IN ADDITION to the live image; `intensity` (Starting Intensity, %) and `decay` (%, compounding per image). The stack stops early once an image is too faint to move an 8-bit target, so a low `decay` with a high `count` costs only what it can show.

`operator` is AE's Echo Operator: `4` Composite In Back (default — the classic trail), `5` Composite In Front (the oldest image wins, so the layer appears to lag its own trail), `0` Add, `1` Screen, `2` Maximum, `3` Minimum (per-channel min including alpha, so only the region *every* image covers survives — it erodes fast, by design), `6` Blend (equal-weight average of every image). Beyond AE: `colorize` (%) ramps 0 → full down the stack toward `tint`, so the tail cools and the live image is never tinted.

`capacity` (4–64 nominal frames) and `resolution` (`100` Full / `50` Half / `25` Quarter) shape the Frame History ring only, are hidden for the Analytic engine, and are deliberately **not keyframable** — they decide an allocation, and animating one only thrashes it. Everything else keyframes as `fx:<eid>:<param>`.

Echo writes outside the layer's current silhouette by definition, so it does not clip by default — leave `clip` unset unless you specifically want the echoes cut to the layer's live shape. Compared with Motion Trail (a Layer Effect): Motion Trail styles ONE layer's own pixels and sits at a fixed point in that layer's pipeline; Echo is a chain entry, so it can be ordered among other Overlay Effects, given an Active Range, and — on an adjustment item — applied to the whole composited stack below it, which Motion Trail cannot do.

#### TimeShift

`timeshift` (**TimeShift**, group Motion, both scopes) is the ARRI timing-shift box: the phase between the shutter and the film movement is shifted, so the shutter is still open while the pulldown drags the film through the gate. One exposure is therefore the picture SLIDING PAST the gate rather than sitting still in it, which is why the look is a **streak along the film path** and not a blur.

- `shift` (0–2, keyframable) is the travel, **measured in frame pitches** — the frame's extent along whichever axis the film runs. Past roughly `0.5` the gate is looking at the neighbouring frame, so **the tail of every streak draws the PREVIOUS frame**. That is the one thing no motion blur can do, and it is what `wrap` gates: `1` On (frame displacement, default) / `0` Off (clamp at the edge). Because the pitch differs per axis, the same `shift` is a longer streak sideways than vertically; that asymmetry is the film's and is deliberately not normalised away.
- `travel` picks the film path: `0` Down / `1` Up / `2` Right / `3` Left. Right and Left are the horizontally running gate (the VistaVision / Techniscope pull). `angle` (−30…30°) tilts it.
- `range` is **Restrict To**, and it is closer to the real thing than smearing everything: on film only the badly over-exposed highlights streak. `0` Everything streaks / `1` Luma window (`rangeLo`, `rangeHi`) / `2` Colour (`rangeHue`, `rangeHueW`, `rangeSat`), with `rangeSoft` (0–100) widening the transition — at 100 the luma window spans the whole scale and the hue falloff a full 180°, so the key becomes a gradient rather than a window. `rangeInvert` flips the selection. **The key reads the SAMPLED pixel, not the destination**, so a selected highlight trails out across unselected areas instead of being clipped to its own silhouette, and the split stays lossless at any softness because what is kept sharp is exactly what the key did not take.
- `headroom` (**Highlight Headroom**, 0–99) is why streaks stay hot. A streak spreads fixed light over a longer path, so it dims as it lengthens — physically right, and on its own it turns every streak to mush, because the real thing is shot on highlights many stops over clipping. Drop it to `0` for the honest, dim version.
- `shutter` (11.25–360°) trades streak length against how much subject motion the streak carries, `falloff` shapes the ramp along it, `jitter` re-dices streak length every frame the way the box's own jitter function does, `gap` rides the unexposed strip between frames through the smear, and `gain` (20–400 %) scales the result.
- `samples` (4–48), `capacity` (**Ring**, 3–16) and `resolution` (`100` Full / `50` Half / `25` Quarter) are allocations, so they are deliberately NOT keyframable — animating one only thrashes it. Everything else keyframes as `fx:<eid>:<param>`.
- It writes outside the layer's silhouette by definition, so leave `clip` unset.

#### Fill

`fill` (**Fill**, group Color, both scopes) is After Effects' Fill: one flat colour painted over everything the item covers, keeping the item's alpha exactly as it was — a soft edge, a keyed subject or a text outline stays as transparent as before, and fully transparent pixels stay transparent. `params.color` is the fill colour (default `#ff3d3d`). `params.blend` selects how that colour meets the original pixels: `0` Normal (default — the flat AE fill) / `1` Multiply / `2` Screen / `3` Overlay / `4` Soft Light / `5` Hard Light / `6` Add / `7` Lighten / `8` Darken / `9` Difference / `10` Color (the fill's hue and saturation at the source's own luminance). The entry's `mix` is the fill's opacity (there is no separate opacity param); keyframe `fx:<eid>:mix` to fade a fill in or out. It is self-clipping (it never writes outside the source alpha), so leave `clip` unset — clipping it multiplies a semi-transparent layer's alpha a second time. On an adjustment item it fills the whole below-stack's coverage. Typical uses: a silhouette (Normal, `mix` 100), a colour tint (Multiply or Color), or a flash (Normal with a keyframed `mix`).

#### Shape Rulers

`shapeRulers` (**Shape Rulers**, group Graphic, **layer scope only**) draws full-frame guide lines along the four edges of the item's own box, with a mark on each corner — a design tool's selection guides. It has no animation of its own: every frame it measures the box from the item's current position, scale and rotation (keyframes, parenting and follow included), so to move, grow or turn the guides, animate the item. The box is the item's plate — a shape's size, an image's picture, a video's frame-sized quad — and on a **text** item the laid-out text block (its lines, alignment and letter spacing — not the frame-sized plate text draws on). Sizes are pixels at 1080p and scale with the frame's short side. `spacingX` / `spacingY` (−200…400 px) push the guides out from the box (negative pulls them in). `rotation`: `1` follows the item's rotation (default) / `0` frames the axis-aligned bounds of the rotated box. Lines: `lineColor`, `lineWidth` (0.5–12 px, default 1.5), `lineOpacity` (0–100 %, default 90), `extend` `0` full frame (default) / `1` past the corners by `extendLength` px / `2` box outline only, `dash` (0–60 px, `0` = solid). Corners: `markShape` `0` Square (default) / `1` Circle / `2` Diamond / `3` Square outline / `4` Circle outline / `5` Cross / `6` Corner bracket / `7` None, `markColor`, `markWidth` / `markHeight` (2–120 px, default 15 × 15), `markRadius` (squares), `markStroke` (outlines, cross, bracket), `midMarks` `1` adds a mark at each edge's midpoint. The guides lie outside the item's silhouette by design, so leave `clip` unset (`true` cuts them down to the artwork); they take the item's opacity and blend mode. Keyframable: every number param and `mix`. Example: `{"id": "shapeRulers", "mix": 100, "params": {"spacingX": 40, "spacingY": 24, "markShape": 6, "markStroke": 3}}`.

#### Copy Color Profile

`copyColor` (**Copy Color Profile**, group Color, both scopes, free) moves this content's colour distribution onto another layer's. `params.sourceLayer` is the **item id** of the reference layer (a `type: 'layer'` param — any other `image` or `video` item in the project, on any channel, at any time; the channel can stay hidden, which is the normal way to keep a colour reference out of shot; `''`, a deleted id or the item's own id = exact bypass). **The reference is always the clip's source picture** (an image: the file; a video: its thumbnail), cover-fitted and measured whole — mean + spread per channel, alpha-weighted — never the layer as posed or effected on screen; text/shape/sequence/model layers have no picture and bypass. The effect's own input is measured the same way (its layer box on a regular item, the whole frame on an adjustment item). The reference layer keeps drawing normally (it is not consumed like a Track Matte source). `space`: `0` Oklab (perceptual, default) / `1` YCbCr / `2` RGB. `transfer`: `0` Statistics (Reinhard-style: centre on the target mean, scale the spread toward the reference's by `contrast` 0–100 % — 0 = shift the mean only — clamped by `maxGain` 1–8, land on the reference mean) / `1` Ratio (multiply by the mean ratio, grey-world white balance; chroma axes shift instead). `lum` and `col` (0–100 %) are how much of the brightness axis and the chroma axes are transferred (in RGB `col` applies to all channels and `lum` blends the source brightness back). `sat` (−100…100 %) scales chroma after the transfer. `protHi` / `protLo` (0–100 %) hold the ends of the tone range so whites stay white and blacks stay black. `inset` (0–45 %) crops the sampled region toward the box centre (skip a border or letterbox); `grid` (8–64, static) is taps per axis. Keyframable: `lum`, `col`, `contrast`, `sat`, `maxGain`, `protHi`, `protLo`, `inset` and the entry's `mix`. Self-clipping (premultiplies by the source alpha), so leave `clip` unset. A reference inside a sequence must be another layer of the same sequence. Example: `{"id": "copyColor", "mix": 100, "params": {"sourceLayer": "<reference item id>", "space": 0, "transfer": 0, "lum": 60, "col": 100, "contrast": 50, "protHi": 30, "protLo": 20}}`.

#### Double Exposure

`doubleExposure` (**Double Exposure**, group Color, both scopes, **PRO** — free to preview, rendering needs a PRO license) puts another layer's picture inside this layer's silhouette: the classic portrait-filled-with-a-forest look. `params.sourceLayer` is the **item id** of the texture layer (a `type: 'layer'` param; `''` / a deleted id / the item's own id = exact bypass). **The texture layer must be on ANOTHER visible channel and overlap this item in time** (`layerRefMode: 'live'` — unlike Copy Color Profile there is no source-picture fallback: a reference that is not on screen together with this item is a plain bypass, and the card's picker only offers layers that can be). While the effect is live the texture is used **as drawn** — its isolate is rendered every frame through its own camera with its transforms, keyframes and layer-effect stack — and it is **consumed**: it no longer draws on its own (like a Track Matte source). So put the texture on its own channel spanning the same time, and position / scale / rotate / keyframe that layer to place the texture; a video texture keeps its trim, speed and effects. There are no scale / offset / rotation params on the effect itself. `blend` (`0` Normal / `1` Screen (default) / `2` Lighten / `3` Add / `4` Multiply / `5` Darken / `6` Overlay / `7` Soft Light / `8` Hard Light / `9` Difference / `10` Exclusion / `11` Color Dodge / `12` Color Burn / `13` Luminosity / `14` Color) is how the texture meets this layer's own shading — Screen over a light background or Lighten over a dark one is the classic recipe, Normal turns the silhouette into a window. `region`: `0` Inside the silhouette (default) / `1` Whole frame / `2` Outside only (1 and 2 add coverage where this layer is transparent). `tones`: `0` Nothing / `1` weight the texture by the layer's shadows / `2` by its highlights. `silhouette`: `0` Layer alpha (default — use a cutout, Magic Mask or RotoScope) / `1` Luma key, dark = background / `2` Luma key, bright = background, with `keyThreshold` (0–100 %) and `keySoftness` (0–50 %); a luma key cuts the layer's alpha. `desaturate` (0–100 %) greys this layer; `texContrast` (0–200 %), `texBrightness` (−100…100 %), `texDesaturate` (0–100 %) grade the texture. `fade`: `0` Off / `1` Fades the texture (default) / `2` Fades texture and layer to transparent — a gradient edge across this layer's box at `fadeAngle` (degrees, `90` = toward the bottom, `-90` = toward the top, `0` = toward the right), centred at `fadePosition` (−200…200 % of the box height from its centre, negative = the other side) over `fadeWidth` (0–200 %). `duotone` (0–100 %) maps the finished plate onto `duoShadow` → `duoHighlight` by luminance. The entry's `mix` is the whole effect's amount. Keyframable: every number param (`keyThreshold`, `keySoftness`, `desaturate`, `texContrast`, `texBrightness`, `texDesaturate`, `fadeAngle`, `fadePosition`, `fadeWidth`, `duotone`) and `mix` — keyframe `fadePosition` from −150 to its resting value for a sweep-in reveal, or `mix` for a plain fade-in. It writes outside the source alpha in the Whole-frame / Outside modes, so leave `clip` unset. A texture inside a sequence must be another layer of the same sequence. Presets in the card: Classic, Noir, Window, Duotone, Negative, Dream. Example: `{"id": "doubleExposure", "mix": 100, "params": {"sourceLayer": "<texture item id>", "blend": 1, "region": 0, "desaturate": 35, "texDesaturate": 30, "fade": 1, "fadeAngle": 90, "fadePosition": 12, "fadeWidth": 50}}`.

#### Film Stock

`filmStock` (**Film Stock**, group Color, both scopes, **PRO** — free to preview, rendering needs a PRO license) is an analog film emulation in the Dehancer mould: one stock preset plus the entry's `mix`. `preset` selects the stock by index — `0` Kodak Vision3 250D (daylight cine negative, clean), `1` Kodak Vision3 500T (tungsten cine negative, cool shadows / warm skin, more grain), `2` Fuji Eterna 500 (low-contrast cine, teal blacks), `3` CineStill 800T (tungsten, strong red halation), `4` Kodak Portra 400 (peach skin, pastel), `5` Fuji Pro 400H (mint greens, cool pastel), `6` Agfa Vista 200 (punchy warm reds), `7` Kodak Ektachrome E100 (clean cool slide, deep blues), `8` Kodachrome 64 (hot reds, ivory whites, brown blacks), `9` Fuji Velvia 50 (maximum saturation slide), `10` Ilford HP5 Plus (black & white, open shadows), `11` Kodak Tri-X 400 (black & white, crunchy, coarse grain), `12` Polaroid 600 (faded instant, cyan shadows, creamy highlights, heavy vignette), `13` Cross Process (blue blacks, yellow whites, crushed contrast). Each stock carries its own white balance, dye matrix, tone curve, split tone, halation, bloom, grain and vignette; `grain`, `halation`, `bloom`, `vignette` (0–300 %, default 100) are multipliers on the stock's own amounts, not absolute values — `halation: 0` removes the glow entirely, `200` doubles it. Film damage is independent of the stock and off by default: `flicker` (exposure wobble), `weave` (gate weave — the whole frame drifts and jitters by a pixel or two), `leak` (a warm-to-magenta light leak breathing in from the right edge) with `leakSpeed` (10–2000 %, default 100 — the leak's clock; 400 % moves it four times as fast). Grain is static (it does not boil between frames); flicker, weave and the leak run on the clip clock, so renders are deterministic. Halation and bloom are true glows (threshold before blur) and bleed past a cutout's alpha, so leave `clip` unset. Keyframable: `grain`, `halation`, `bloom`, `vignette`, `flicker`, `weave`, `leak`, `leakSpeed` and the entry's `mix`; `preset` is a select. Presets in the card: Clean Scan, Projected Print, Worn Reel, Light Leak. Example: `{"id": "filmStock", "mix": 100, "params": {"preset": 3, "grain": 100, "halation": 120, "bloom": 100, "vignette": 100, "flicker": 0, "weave": 0, "leak": 0, "leakSpeed": 100}}`.

#### Fast Blur

`fastBlur` (**Fast Blur**, group Lens, both scopes, free) is After Effects' Fast Box Blur. `blurriness` (0–250 px at 1080p, default 20) is the box radius: every iteration convolves a box `2 × blurriness + 1` px wide, so the visible spread is about `iterations × blurriness`. `iterations` (1–5, default 3): `1` is a hard box (a square-edged smear), `3` reads as Gaussian, and more iterations blur more, as in AE. `dimensions`: `0` Horizontal and Vertical (default) / `1` Horizontal / `2` Vertical (a one-axis blur is a motion-smear look and keeps the other axis sharp). `repeatEdges`: `1` On (default, the frame edges stay solid) / `0` Off (the frame edges fade toward transparent, as in AE's default). `blurriness: 0` is an exact bypass that costs no render pass. Fractional and keyframed `blurriness` animate smoothly, with no stepping. It is a growth effect: the blur spreads past a cutout's silhouette, so leave `clip` unset. Keyframable: `blurriness`, `iterations` (rounded to whole iterations) and `mix`; the selects are not. Presets in the card: Soft, Defocus, Heavy, Box, Smear H, Smear V. Example: `{"id": "fastBlur", "mix": 100, "params": {"blurriness": 24, "iterations": 3, "dimensions": 0, "repeatEdges": 1}}`. A rack-focus pull is a keyframed `fx:<eid>:blurriness` track from 40 to 0.

#### Radial Fast Blur

`radialFastBlur` (**Radial Fast Blur**, group Lens, both scopes, free) is After Effects' CC Radial Fast Blur: every pixel gathers the picture along the line towards `centerX`/`centerY`, so content smears AWAY from the Center. It is the effect for light rays and light cones (a thin line lit from behind), zoom bursts and shadow rays; `radialBlur` is only a short symmetric zoom and `lightRays` averages a few dozen taps, so neither can carry a 2–4 px line over a long trail.

- `amount` (0–100 %, default 50): how far back towards the Center each pixel reaches — 60 reaches 60 % of the way, so a feature at distance d smears out to d / (1 − 0.6) = 2.5 d; 87 → 7.7 d, 94 → 16.7 d. `0` is an exact bypass with no render pass.
- `zoom` (AE's name): `0` Standard (a normalised zoom blur — a thin line is diluted along its trail), `1` Brightest (the brightest colour along the trail, per channel — a thin bright line stays at full strength; light rays), `2` Darkest (the darkest colour along the trail — shadow rays; transparent pixels are neutral, so a layer's empty surround never wins).
- `falloff` (0–100 %, default 0): the trail dims by this much each time its distance from the Center doubles (50 → half strength at 2×, a quarter at 4×).
- `intensity` (0–5000 %, default 100): stacks the trail onto itself — opacity `1 − (1 − α)^intensity`, colour kept. With Falloff it gives a light cone's plateau, smooth shoulder and long tail: the trail holds full strength until Falloff has thinned it to about 1 / intensity. 100 is the identity.
- `centerX` / `centerY` (−0.5…1.5, default 0.5): 0–1 with **y UP**, like every effect centre. An After Effects point (x, y) in a W×H comp is `centerX = x / W`, `centerY = 1 − y / H`.
- `space`: `0` Layer (default — the Center is in the layer's own box and rides it, like Radial Blur) / `1` Composition (the Center is pinned to the frame: a fixed light that a moving, rotating layer passes in front of — how CC Radial Fast Blur behaves on an AE shape layer). On an adjustment item the box is the frame, so both read the same.

It writes outside the silhouette by design; leave `clip` unset. Keyframable: `amount`, `centerX`, `centerY`, `falloff`, `intensity`, `mix`; the selects are not. Cost when used: a 3×3 prep and 1–5 eight-tap levels at half resolution (4 levels for Amount ~85 at 1080p — the fewest that keep the trail contiguous at the frame corner) plus one full-resolution pass; the full-resolution source stays sharp wherever the trail is under ~2 px. Presets in the card: Zoom Burst, Light Rays, Light Cone, Long Streaks, Shadow Rays. Example: `{"id": "radialFastBlur", "mix": 100, "params": {"amount": 85, "centerX": 0.27, "centerY": 0.5, "zoom": 1, "falloff": 75, "intensity": 400, "space": 1}}`.

**Light cone through a line (the AE "Light Text Reveal" port).** The AE rig is a 2–4 px line whose own layer carries CC Radial Fast Blur ×2, Glow ×4 and Tint, with the text layers using it as a LUMA track matte. Rebuild it as:

1. A `sequence` clip holding: the glow line (`shapeType: "line"`, `lineWidth` 4, `lineStroke.paint` `{mode: "gradient", colors: ["#ffffff", "#000000", "#000000"], span: "path"}` — AE's white→black gradient stroke, which becomes the yellow→green split after the tint), animated with the AE `translateX/Y`/`rotate` keys; an adjustment item with `radialFastBlur` twice — Center 1 = Glow Position + (0, Spread), `zoom` 1, `falloff` 98, `intensity` 1500, `mix` 40; Center 2 = Glow Position − (0, Spread), `zoom` 1, `falloff` 96, `intensity` 1000 — `space` 1 on both, `amount` = AE amount (80 + Light Distance, 80 + 2 × Light Distance); and a second adjustment item with AE's outer glows (`glow` 0.5 / threshold 0.71 / radius 80, `glow` 0.1 / threshold 0 / radius 54), the Tint as `curves` with two points per channel (black → Light Color 3, white → Light Color 2: `r [[0, 43/255], [1, 198/255]]`, `g [[0, 217/255], [1, 1]]`, `b [[0, 143/255], [1, 74/255]]`) and AE's comp Curves as a second `curves` (kept inside the cone: on top of everything it also dims the white line). An effect chain holds 4 entries, hence two adjustment items.
2. Two items of that ONE sequence clip at the top level: one visible (the cone), one used only as the matte source (a matte source is hidden from output).
3. The white line (2 px) on its own channel, and the text with `trackMatte: {sourceId: <the matte item>, mode: "luma"}`.
Key the light on/off with the cone items' `opacity` plus `fx:<eid>:amount`, and raise `fx:<eid>:falloff` towards 99.8 as it goes off (CC's trail shortens with Amount; here the visible length is set by Falloff); key the light source with `fx:<eid>:centerX/centerY`. A ready rig: `tests/radial-fast-blur/build_light_rig.py`. CC's Standard mode keeps a thin line bright, which this effect's normalised Standard does not; Brightest + Falloff + Intensity is the measured match (see the report in `tests/radial-fast-blur/README.md`).

#### Grid

`gridLines` (**Grid**, group Graphic, both scopes, free) draws anti-aliased grid lines over the item. `lines`: `0` Columns and Rows (default) / `1` Columns Only (vertical lines) / `2` Rows Only (horizontal lines). `cellSize` (4–600 px, default 120) is the line spacing, `lineWidth` (0–40 px, default 1.5; widths under 1 px fade rather than flicker; `0` is a bypass), `rotation` (−180…180°, clockwise positive) turns the grid about its anchor, and `offsetX` / `offsetY` (−1000…1000 px, `+Y` = down) move the anchor from the centre. A line always passes through the anchor, so animating `offsetX` by one `cellSize` per second pans the grid seamlessly. `color` is the line colour; the entry's `mix` is the line opacity. Sizes are px at 1080p of the item's own box. On a regular item the grid is printed on the artwork: it moves, scales and rotates with the item and takes the item's own alpha (no lines over transparent pixels), so leave `clip` unset. On an adjustment item it covers the whole frame, transparent areas included. On an adjustment layer, axis-aligned odd-width lines snap to pixel centres, so `lineWidth: 1` at 1080p is one crisp pixel. Keyframable: `cellSize`, `lineWidth`, `rotation`, `offsetX`, `offsetY`, `mix`. Presets in the card: Hairline, Blueprint, Columns, Rows, Diagonal, Bold. Example: `{"id": "gridLines", "mix": 60, "params": {"lines": 0, "cellSize": 120, "lineWidth": 1, "rotation": 0, "color": "#ffffff"}}`.

#### Strip

`strip` (**Strip**, group Graphic, both scopes, free) draws a solid bar along the top and the bottom edge of the item: a letterbox. Use it for cinematic bars instead of two rectangle shapes. One entry follows the item, and the slide in and out is built in.

- `height` (0–50 %, default 8) is each bar's thickness in % of the item's box height (the frame height on an adjustment item). The picture left between the bars is `aspect / (1 − 2 · height / 100)`, so on 16:9 `12.8` gives 2.39:1, `5.6` gives 2:1 and `17.8` gives 2.76:1. `0` is a bypass.
- `color` (default `#000000`) is the bars' colour. The entry's `mix` is their opacity.
- `intro`: `1` On (default) / `0` Off. The top bar slides down from above the box and the bottom bar slides up from below it, over `introDuration` seconds (0.05–5, default 1.25) from the item's start, on `introEasing` (default `"Smooth"`). At the item's first frame the bars are not there yet.
- `outro`: `0` Off (default) / `1` On. The same move backwards over `outroDuration` (0.05–5, default 0.8), finishing on the item's last frame, on `outroEasing` (default `"Smooth"`).
- With `start` / `end` set, the entrance starts at `start` and the outro finishes at `end`. If the two durations together are longer than the item (or the window), the bars turn back early instead of jumping.
- The bars sit on the item's box. On a regular item they move, scale and turn with it and cover the box whatever its alpha, so leave `clip` unset. On an adjustment item they span the whole frame, which is the usual letterbox over footage.
- Keyframable: `height`, `mix`. The switches, durations and easings are static.

Example, a 2.39:1 letterbox that slides in and out over everything below (on an adjustment item): `{"id": "strip", "eid": "letterbox", "enabled": true, "mix": 100, "params": {"height": 12.8, "intro": 1, "introDuration": 1.25, "introEasing": "Smooth", "outro": 1, "outroDuration": 0.8, "outroEasing": "Expo In"}}`.

#### ASCII

`ascii` (**ASCII**, group Print, both scopes, free) rebuilds the picture from characters. Each cell's average tone picks a glyph from a ramp sorted by how much ink each character has (sparse = dark, dense = bright). `cellSize` (6–400 px at 1080p of the item's box, default 14) is the character height; the width follows the font. `charset`: `0` Standard ` .:-=+*#%@` (default) / `1` Detailed (70 characters) / `2` Blocks `░▒▓█` / `3` Binary / `4` Dots / `5` Matrix (half-width katakana) / `6` Custom, which uses `customChars`. `customChars` is a `type: "text"` param: a string of up to 80 characters, de-duplicated and auto-sorted by ink, with a space added for empty cells, so any word works. `font`: `0` Mono / `1` Mono Bold (default) / `2` Sans Bold / `3` Serif. `colorMode`: `0` Source (each glyph in its cell's colour, `colorBoost` 0–100 % pushes it toward full brightness) / `1` Single Color (`glyphColor`) / `2` Gradient (`glyphColor` for dark cells → `lightColor` for bright ones). `background`: `0` Solid (`backgroundColor`, default `#050505`) / `1` Source (the picture behind the glyphs at `sourceLevel` 0–100 %) / `2` None (transparent between glyphs). `contrast` (0–300 %, default 120) and `brightness` (−100…100) shape the tone before glyphs are picked. `invert` `1` maps dark areas to dense glyphs, the dark-ink-on-paper look (pair it with a light `backgroundColor`). `dither` (0–100 %, default 60) breaks up the contour lines a slow gradient would otherwise draw; it is fixed per cell, so video does not shimmer. `edgeLines` (0–100 %, default 0) swaps in `- / | \` along contours, following the edge direction. The character grid is printed on the item's box, so on a regular item it rides the layer; `clip` defaults on (the background is cut to the item's shape). Keyframable: `cellSize`, `colorBoost`, `sourceLevel`, `contrast`, `brightness`, `dither`, `edgeLines`, `mix`; the selects, colours and `customChars` are not. Presets in the card: Terminal, Color, Blocks, Binary, Matrix, Edges, Paper. Example: `{"id": "ascii", "mix": 100, "params": {"cellSize": 14, "charset": 6, "customChars": "GREENLIGHT", "font": 1, "colorMode": 1, "glyphColor": "#39ff7a", "background": 0, "backgroundColor": "#040806"}}`.

#### Mosaic

`pixelate` (**Mosaic**, group Display, both scopes, free) rebuilds the item from flat blocks. Use it for every pixelated look: pixel blocks, a mosaic, an 8-bit look, censor blocks, a pixelate transition. `crtMatrix` is a screen texture (CRT, LED and LCD sub-pixels), not pixelation.

- `sampling`: `0` Average (default) makes each block the exact mean colour of the pixels under it. The mean is premultiplied, so a half-covered block is half transparent and soft content turns into soft blocks. `1` Center takes the colour at the block centre: crisper and harder, but blocks flicker as detail moves under them.
- `size` (1–400, default 24) is the block size in px at 1080p of the frame, the geometric mean of width and height. Below 1.5 the effect is off and costs nothing, so a `size` track that starts at 1 fades the blocks in cleanly.
- `stretch` (−100…100 %, default 0) sets width : height at the same area. `+100` makes blocks 8× wider than tall (horizontal bands); `−100` makes them 8× taller (columns).
- `grid`: `0` Layer (default) puts the blocks on the item's own box. They move, turn and tilt with it and are clipped to the box, so the item's edge stays straight; anything an earlier effect drew outside the box passes through unpixelated. `1` Frame fixes the blocks to the frame, and the item moves through them like a low-res screen. A block the item only partly covers averages in the transparency around it, so the edge breaks into soft blocks, and anything an earlier effect drew outside the box (an `echo` trail, a glow) is pixelated too. On an adjustment item both values pixelate everything below on the frame grid.
- `offsetX` / `offsetY` (−100…100 % of a block, `+Y` = down) slide the grid. At 0 one block is centred on the box (Layer) or the frame (Frame), so a growing `size` opens from the middle. 100 % is exactly one block, so a key from 0 to 100 loops seamlessly.
- Keyframable: `size`, `stretch`, `offsetX`, `offsetY`, `mix`. `sampling` and `grid` are static.
- Leave `clip` unset. The blocks are the new edge, and `clip: true` cuts them back to the smooth silhouette.

Starting points: soft blocks `{"size": 36, "grid": 1}` · censor mosaic `{"size": 22}` · 8-bit `{"size": 10, "sampling": 1, "grid": 1}` · giant blocks `{"size": 120}` · columns `{"size": 30, "stretch": -80, "grid": 1}` · bands `{"size": 26, "stretch": 80, "grid": 1}`. For a pixelate transition, key `fx:<eid>:size` from about 120 down to 1 at the start of the item (in) or from 1 up to 120 at its end (out).

The soft pixel-blob look turns a blurry colour shape and its trail into blocks. Build it from a soft ellipse (`filterBlur`), then an `echo` for the trail (Analytic engine `1`, Maximum operator `2`), then `pixelate` on the Frame grid, so the head and the trail share one fixed block lattice as the shape moves. In a 1920×1080 project:

```json
{
  "clips": [
    { "id": "blob-clip", "source": "LOCAL", "mediaType": "shape", "url": "", "proxyUrl": null, "name": "Blob", "duration": 4 }
  ],
  "channels": [{
    "id": "blob-channel", "name": "Blob", "visible": true,
    "items": [{
      "id": "blob-item", "clipId": "blob-clip", "trimStart": 0, "trimEnd": 4,
      "shapeType": "ellipse", "shapeSizeUnit": "px", "shapeWidthPx": 560, "shapeHeightPx": 470,
      "shapeFillColor": "#1d22ff", "filterBlur": 10,
      "propertyKeyframes": {
        "translateX": [
          { "position": 0, "value": "-1250", "easing": "AE Smooth" },
          { "position": 100, "value": "560", "easing": "AE Smooth" }
        ],
        "translateY": [
          { "position": 0, "value": "520", "easing": "AE Smooth" },
          { "position": 100, "value": "20", "easing": "AE Smooth" }
        ]
      },
      "effects": [
        { "id": "echo", "eid": "blob-echo", "enabled": true, "mix": 100,
          "params": { "engine": 1, "echoTime": -0.1, "count": 10, "intensity": 100, "decay": 88, "operator": 2 } },
        { "id": "pixelate", "eid": "blob-pixels", "enabled": true, "mix": 100,
          "params": { "size": 36, "grid": 1 } }
      ]
    }]
  }]
}
```

#### Posterize

`posterize` (**Posterize**, group Color, both scopes, free) cuts every colour channel down to `level` tones. It is After Effects' Posterize, pixel for pixel, so use it whenever a brief says posterize, poster, screenprint, flat colour bands or fewer colours. Colorama's Constant interpolation maps brightness onto a gradient instead.

- `level` (2–255, default 5) is the tones per channel. The bins are equal slices of 0–255 and the tones run evenly from black to white: Level 3 gives 0, 128 and 255; Level 2 gives eight pure colours. Fractions are kept, as in AE: a keyed `level` slides the bands smoothly between whole levels instead of stepping.
- `channels`: `0` RGB (default) posterizes each channel on its own, which is AE's look and shifts hues on soft colour. `1` Luminance cuts only the brightness into `level` bands and keeps each pixel's colour, for a cel-shaded or illustrated look.
- `dither` (0–100 %, default 9) dissolves the band edges with an ordered (Bayer 8×8) pattern; `0` is exactly AE. The bands stay where AE puts them, so a low value only softens their edges and 100 % turns them into a full retro dither. `ditherSize` (1–8 px, default 1) is the dot size. The pattern is fixed to the item, so it moves with it instead of crawling.
- Alpha is never changed, and a semi-transparent pixel is posterized on its own colour, so soft edges and shadows stay soft. Leave `clip` unset: `clip: true` multiplies semi-transparent pixels by their alpha a second time.
- Keyframable: `level`, `dither`, `ditherSize`, `mix`. `channels` is static.

Starting points: AE's default `{"level": 7, "dither": 0}` · screenprint `{"level": 3, "dither": 0}` · eight colours `{"level": 2, "dither": 0}` · tone bands `{"level": 5, "channels": 1, "dither": 0}` · retro dither `{"level": 3, "dither": 100, "ditherSize": 2}` · soft contour `{"level": 8, "channels": 1, "dither": 40}`.

To posterize everything below, put it on an adjustment item (channel order as in [Adjustment-layer Overlay Effects example](#adjustment-layer-overlay-effects-example)). For a posterize-in, key `fx:<eid>:level` from a few tones up to about 64, where the bands are no longer visible. This channel goes after the footage's channels; it holds three flat tones, then resolves into the picture over the first 1.2 s:

```json
{
  "clips": [
    { "id": "poster-clip", "source": "LOCAL", "mediaType": "adjustment", "url": "", "proxyUrl": null, "name": "Posterize", "duration": 3 }
  ],
  "channels": [{
    "id": "poster-channel", "name": "Posterize", "visible": true, "unsnapped": true,
    "items": [{
      "id": "poster-item", "clipId": "poster-clip", "freeStart": 0, "trimStart": 0, "trimEnd": 3,
      "effects": [
        { "id": "posterize", "eid": "poster-in", "enabled": true, "mix": 100,
          "params": { "level": 3, "channels": 0, "dither": 9, "ditherSize": 1 } }
      ],
      "propertyKeyframes": {
        "fx:poster-in:level": [
          { "position": 0, "value": "3", "easing": "AE Smooth" },
          { "position": 40, "value": "64", "easing": "AE Smooth" }
        ]
      }
    }]
  }]
}
```

#### Motion Effects II notes

Nine of them have non-obvious semantics: `lightRays`, `longShadow`, `outlineBands`, `lensPrism`, `kaleidoscope`, `crtMatrix`, `vectorFieldWarp`, `pixelStretch`, `edgeDetect`. Non-obvious semantics:

- `longShadow` is **layer-scope only** — it paints outside the source silhouette, which an adjustment layer's opaque below-stack has no room for.
- `outlineBands` grows contour bands from a distance field. On a regular layer the default `source: 0` (Alpha) uses the layer silhouette; on an adjustment item alpha is the opaque below-stack, so use `source: 1` (Luminance) or `2` (Edges) there. `params.ramp` is a CSS gradient string colouring the band field near → far.
- `lightRays` in `source: 0` (Alpha) mode makes the layer silhouette emit; on an adjustment item prefer `1` (Luminance) or `2` (Highlights). `originX`/`originY` are in the layer's own 0–1 box and may go outside it (e.g. `originY: 1.2` for light from above). It averages 24–48 taps, so a thin line smeared over a long distance comes out dotted and faint — use `radialFastBlur` (Brightest) for that.
- `pixelStretch` is deliberately a realtime pixel-**stretch** approximation, not an exact sort.
- `edgeDetect` (**Edge Detect**, group Graphic, both scopes) turns the content into a styled edge overlay. `method` picks the detector: `0` Gradient (thick luminous outlines, `operator`/`threshold`/`knee`), `1` Thin Line/Canny (1px lines; `lowRatio` + `linkIter` control hysteresis), `2` Ink Sketch/XDoG (`dogSigma`/`dogK`/`dogTau`/`dogPhi`/`dogEps` — keeps hatching and shading), `3` Contour Bands (`bands` luminance level-sets). There is **no backdrop** — `sourceLevel` (0–100, keyframable) shows the original underneath: `0` is pure edges over transparency in layer scope, `100` is the full original with edges on top (use `blend: 1` Add for the glowing-outline social look). `colorMode`: `0` flat `edgeColor`, `1` source color, `2` hue from each edge's own gradient angle, `3` duo ramp `edgeColor2`→`edgeColor` by luminance. `animMode` drives itself from the clip clock: `1` Draw On and `2` Scanner sweep along `sweepAngle` (layer-space, rotates with the layer) across the clip's duration — the Scanner shows the untouched original ahead of the line; `3` Flicker, `4` Glow Pulse, `5` Line Boil (hand-drawn wobble) run on clip time. `animSpeed` (0.1–4×) scales all of it — the sweeps complete in 1/speed of the clip, the clock modes tick that much faster. Presets: Neon Wire / Outline Pop / Ink Sketch / HUD Scanner / Topographic / Prism Flow / Electric Ghost — all ship with `animMode: 0`; turn animation on deliberately.
- Directions (`longShadow.direction`, prism axis) are authored in the layer's own frame and rotate with it.

`fastCameraWiggle` (**Fast Camera Wiggle**, group Motion, both scopes) mimics fast handheld camera shake with real shutter motion blur — built for shot cuts. fBm noise drives a screen affine of the plate (offset / roll / zoom pulse), and the blur is exact: `samples` sub-frame transforms across the `shutter` window (degrees at a 30fps reference, up to 720) are averaged in one pass. `amount` is the master (0–2000%; 100% ≈ 10% of frame height of peak excursion) and scales offsets, `rotation` and `zoomPulse` together — for a shot cut, **keyframe `fx:<eid>:amount`**: spike it at the cut frame and decay to 0 over ~10 frames. The default `frequency` (1 Hz) is a slow drift; cut shakes want ~8–17 Hz. `xWeight`/`yWeight` shape the direction (handheld reads best with Y below X), `roughness` is the noise persistence (high = jerkier), `seed` decorrelates instances. `phase`: `0` Trailing (streak behind the motion, default) / `1` Centered. `edges`: `0` Mirror (tiles in the layer's box — the full-frame default), `1` Zoom to Cover (auto punch-in computed from the amplitude bound, capped 4×, so it follows a keyframed amount), `2` Transparent (the isolated plate's real edges). The wiggle is a pure function of the clip-local clock, so scrubbing and renders are deterministic; two instances with the same seed shake identically. Pivot is the layer's own centre (frame centre on an adjustment item), so an off-centre layer shakes in place. It writes outside the silhouette by design; leave `clip` unset. Presets: Subtle Handheld / Fast Cut / Impact / Whip Chaos / Earthquake MAX.

`sdfLensBlur` (**SDF Lens Blur**, group Optical, both scopes) defocuses the content under a soft travelling circular lens. `mode: 0` blurs inside the lens; `mode: 1` inverts it (everything defocused *except* the lens region — a focus spotlight). `lensPath` selects `0` Orbit, `1` Figure 8, `2` Sweep, or `3` Manual; `lensX`/`lensY` are the path centre (or the fixed spot with Manual) in the layer's own 0–1 box, so the lens rides a moving layer. `magnify` adds a loupe-style refraction bulge that follows the lens even in Focus mode. `blur` is the maximum defocus in 1080p-reference px; `0` disables the blur passes entirely.

`opticsCompensation` (**Optics Compensation**, group Lens, both scopes) is the lens-angle warp: `fov` is a real Field of View in degrees measured across the dimension chosen by `orientation` (`0` Horizontal, `1` Vertical, `2` Diagonal), and `reverse` picks the direction — `0` adds barrel distortion, `1` removes it. The two are exact inverses, so the same `fov` and `orientation` applied twice with opposite `reverse` returns the original plate; that is the way to undistort footage, warp it, and redistort it. `fov: 0` is a no-op. Adding barrel empties the corners and removing it crops them, so `resize: 1` (Fit) rescales the plate to put the source corner exactly on the frame corner; `zoom` scales on top of that. `centerX`/`centerY` are the view centre in the layer's own 0–1 box and stay a fixed point of the warp. Prefer this over `fisheye`, whose `distortion` is a unitless polynomial coefficient with no inverse.

`warpStyles` (**Warp Styles**, group Distortion, both scopes) is AE's **Warp** effect — one whole-layer shape chosen by `style` (`0` Arc, `1` Arc Upper, `2` Arc Lower, `3` Arch, `4` Bulge, `5` Flag, `6` Wave, `7` Fish, `8` Rise, `9` Inflate, `10` Squeeze, `11` Twist), scaled by `bend` (−100…100 %, signed: negative mirrors the shape). `distortH`/`distortV` (−100…100 %) add the perspective skew of the same AE control and stack on top of any style. All three amounts are keyframable; `style` is a select, so animate the amounts, not the shape. `bend: 0` with both distortions at `0` is an exact bypass. The warp is measured in the layer's own box and rides it, and it deliberately writes **outside** that box (an arc lifts the middle clear of the layer's own top edge), so leave `clip` unset. Only what was inside the box is warped — anything the map pushes off the source is simply not drawn, which is what gives the arced/twisted silhouette its clean edge. Past roughly ±70 % on Inflate, Squeeze and Twist the shape starts folding over itself and the folded region drops out rather than smearing. On an adjustment item the box is the whole frame, so the below-stack warps as one sheet.

`curves` (**Curves**, group Color, both scopes) applies Photoshop-style tone curves. Its single param `curves` is an object of four channels — `m` (master RGB), `r`, `g`, `b` — each a list of `[x, y]` points in the 0–1 unit box (`x` = input, `y` = output), at least 2 and at most 16 points per channel, sorted by `x`. Identity is `[[0,0],[1,1]]`. Interpolation between points is monotone cubic (no overshoot), values are clamped to 0–1, and the master curve is applied after the per-channel curves. The `curves` param is not keyframable; keyframe the entry's `mix` to animate the grade. Example: `{"id": "curves", "mix": 100, "params": {"curves": {"m": [[0,0],[0.25,0.18],[0.75,0.82],[1,1]], "r": [[0,0],[1,1]], "g": [[0,0],[1,1]], "b": [[0,0],[1,1]]}}}`.

`extract` (**Extract (Histogram Key)**, group Matte, both scopes) keys on a value RANGE of one channel — AE's Extract. `exChannel` picks what is measured (`0` Luminance (Rec.709), `1` R, `2` G, `3` B, `4` Alpha, `5` Max RGB, `6` Saturation) and the pixel survives when that value lies inside `[exBlack, exWhite]`, both ends 0–255 and both INCLUSIVE — the defaults `exBlack: 0` / `exWhite: 255` are an exact bypass. `exBlackSoft` ramps up from `exBlack`, `exWhiteSoft` ramps down to `exWhite`; `exInvert: 1` removes the range instead of keeping it. `exKeepAlpha: 1` (default) multiplies the key into the layer's existing alpha, so a cutout stays a cutout; `0` ignores it. Matte shaping beyond AE: `exGamma` (−100…100) biases the alpha ramp, `exBlur` (px) softens the matte, and `exChoke`/`exEdge` re-threshold it — **choke does nothing at `exBlur: 0`**, because a hard matte has no soft band to slide the pivot through. `exBoost` (Unpremult Boost) lifts thin keyed content (smoke, fire) back toward its full-coverage colour, and `exTintAmount`/`exTint` recolour the result. `exView: 1` shows the matte and `2` the raw channel — both are inspection views, so leave it `0` in delivered projects. The four range params are the ones to keyframe (`fx:<eid>:exBlack` etc.): sweeping `exBlack` 0 → 255 burns the layer away from its darks up, and a narrow `[exBlack, exWhite]` window travelling together is a band scan.

`neonGlow` (**Neon Glow**, group Glow, **layer scope only**, **PRO** — free to preview, rendering a project that uses it needs a PRO license) runs a neon light (hot core + 1/distance halo) along the LAYER'S OWN OUTLINE, on any visual layer:

- **shape** clips: the shape's real path — `shapePath` points (keyframed morphs followed), preset outlines (rectangle incl. radii, ellipse, circle, triangle, arrow), or a custom/vector SVG's longest geometry element.
- **text** and **motion** clips: the glyph/artwork contours traced from the layer's own rendered alpha, concatenated left→right.
- **image** clips: the traced alpha silhouette of the file; fully opaque images fall back to the media content rect (with the item's corner radii).
- **video** and other media: the media content rect.

Params: `pathSpeed` (loops/s, negative = reverse), `pathTrimStart`/`pathTrimEnd` (% of the outline), `pathTrail` (% of the trimmed range lit behind the head), `pathCoreSize`/`pathGlowRadius` (px in the layer's own plate), `pathIntensity`, `pathHueCycle` (°/s), `pathSourceLevel`, `pathRelax` (Relax Points 0–100% — bake-side Laplacian smoothing of the baked outline points, per contour: it rounds the pixel-staircase of a traced glyph contour and softens sharp polyline corners, and high values round glyphs into a loose neon wire; NOT keyframable), `pathColor1`. The per-effect `mix` is the master amount, and `start`/`end` give it an Active Range like any chain entry. All number params keyframe as `fx:<eid>:<param>` tracks; **`pathSpeed` and `pathHueCycle` are rates whose tracks are INTEGRATED over clip time** (a ramp accelerates the runner smoothly; an Active Range rebases the phase onto its own start). The lit run is always the **exact baked outline** clipped to the window behind the head — at every trail length, not just 100%. Nothing is resampled, so the light never jumps. Bridges between contours never light and each contour closes onto itself, so on text the light walks glyph by glyph (Trail 100% on a closed outline therefore lights every contour as its own complete neon ring). Legacy `layerEffects` entries with id `neonGlow`/`pathEffects` migrate automatically: the entry moves into `effects`, its `pathAmount` becomes the chain `mix`.

`linesDraw` (**Lines Draw**, group Glow, **layer scope only**, **PRO**) chases up to eight tapered glowing ribbons along the same per-media outline Neon Glow uses (shape path / traced text or motion contours / image alpha silhouette / media rect). The distinctive behaviour is **speed-driven accumulation**: the head's pace along the outline comes from an eased lap progress (`ldDirection` selects the travel mode — `0` Forward default: every lap re-draws from the path start, `1` Backward, `2` Ping-Pong; `ldProfile`, a select — `0` AE Smooth default, then AE In/Out, Cubic/Natural/Expo/Back in-out, rhythm profiles Dash & Pause / Elastic Stops / Stutter / Heartbeat, Sprint & Drift, Wind-up Blast, Surge, Chaos, Linear), and BOTH the ribbon width and its visible trail length scale with the head's instantaneous speed — trails bloom on sprints and collapse to a dot at stops. `ldLapDur` (s per lap, default 2), `ldLines` (1–8, default 4 — each line carries a fixed ring offset of `ldSpread` px around the head — at a stop every line collapses to its own point — with optional `ldLag` % stagger (default 0) and colours cycling `ldColor1..3`), `ldTrail` (max % of outline), `ldWidth` (max px) with `ldSpeedGain`/`ldMinWidth`/`ldSmooth` (speed→width response and its smoothing window in seconds), `ldTaper` (end taper), `ldRound` (Path Smooth — low-pass outline resampling, % of arc, rounds sharp polyline corners), `ldGlow`/`ldIntensity` (bloom), `ldHeadBright` (whitening toward the head), `ldSourceLevel` (underlying layer opacity). The trail's visible length rides the speed factor too, so it collapses to a dot wherever the head stops. Closed outlines lap continuously; in Ping-Pong mode open outlines bounce and the trail swings behind the head on the return leg. The phase is a pure function of clip time — no simulation state — so range renders and scrubs are exact.

#### Object effects (subject-tracked)

`objectDither` (**Dither Print**), `objectIsolines` (**Field Isolines**) and `objectWindow` (**Portrait Window**), group Object, **layer scope only**. They read a SUBJECT FIELD — a per-effect weight map of where the person/face is — and each entry owns its own.

The field lives in an optional `track` object **top-level on the entry**, beside `mix` and `start`/`end`, never inside `params`:

```json
{
  "id": "objectDither",
  "eid": "obj-1",
  "mix": 100,
  "params": { "region": 1, "trackSource": 0 },
  "track": { "v": 1, "w": 64, "h": 64, "src": 0, "kind": "image",
             "person": 0.56, "faceScore": 0.93, "found": true,
             "samples": [{ "t": 0, "f": "<base64>", "fc": [0.37, 0.11, 0.27, 0.49, 0.93] }] }
}
```

- `w`/`h` size the weight field; each sample's `f` is that field run-length encoded (`[value, runLength]` byte pairs) then base64'd, 0 = background, 255 = subject, row 0 = the TOP of the media.
- `samples[].t` is **source** seconds (media time, not clip time), so trimming or speed-ramping the clip keeps the track aligned; a still has one sample, a clip is sampled at a few Hz and interpolated.
- `fc` is `[x, y, w, h, score]` of the face box in media uv, y from the top.
- A malformed field drops the whole `track` on load — and so does ANY bad sample in it, a run-length pair that covers nothing, an odd byte count, more than 200 samples, an unknown `v`, or a track over 900 KB. **Preserve `track` verbatim** when editing an entry: it is detection output, it cannot be reconstructed from the other fields, and the effects still render without it (the field reads as a flat 1.0 — every region control then treats the whole layer as the subject).
- `track.scan` is what that scan WAS — `{ media, feather, faceBoost, from, to }`. The panel compares it with the card's current controls and shows a re-scan hint when they disagree, so carry it with the track; a track without it is only checked on `trackSource`.

`params.trackSource` (`0` person silhouette, `1` face, `2` both), `trackFeather` and `trackFaceBoost` describe how the field was built, so they only take effect for a `track` produced with them: changing any of the three marks the stored scan stale in the panel, as does swapping the layer's media or trimming past what the scan covered.

The pack has eleven programs in two families. **Fragment programs** shade pixels: `objectDither` (Dither Print), `objectIsolines` (Field Isolines), `objectWindow` (Portrait Window), `objectSlitScan` (Slit Scan), `objectCurtain` (Spectral Curtain), `objectGrid` (Grid System), `objectContour` (Contour Studio). **Geometry programs** draw strokes and type on a Canvas2D plate: `objectNodes` (Node Field), `objectLinks` (Link Graph), `objectFacets` (Facet Plates), `objectMeasure` (Measure Rig).

`objectNodes`, `objectLinks` and `objectFacets` take `stabilise` (0–100, default 100) — VIDEO ONLY: points keep an identity between frames and ease toward each new solve instead of being re-dealt, with hysteresis at the point budget; `0` is the raw per-frame solve, and a still ignores it. Every geometry program shares the extraction that feeds it — `analysis` (256/384/512/768 px), `density` (a **cap** on points, not a target: the count saturates against threshold and resolution), `threshold`, `preBlur` (a DETECTION control that never reaches the picture), `bias` (how hard the subject field concentrates points), `faceProtect` (`0` off, `1` reduce, `2` exclude) and `seed` — plus `opacity` for the plate itself. `objectMeasure` takes no extraction params; it annotates a box, not a point set.

Look controls: `objectDither` prints a 1-bit screen over the plate — `algo` (`0` Bayer 4×4, `1` Bayer 8×8, `2` Noise, `3` Halftone dots), `pitch` (grain pitch in 1080p-reference px), `threshold`, `contrast`, `edge` (edge preserve), `autoLevel` (`0` off, `1` local), `paperAmount`, `subjectDetail` (subdivides cells on the subject), `ink`/`paper`. `objectIsolines` draws level sets of the field itself — `rings`, `spacing` (in field cells), `inward`, `weight`, `dash`, `fade`, colours `ink`/`inkIn`/`accent`; with no `track` it is an exact bypass, because it has nothing to draw. `objectWindow` locks a treated window to what was detected — `target` (`0` face box, `1` subject bounds, `2` whole layer), `treatment` (`0` halftone, `1` engrave, `2` sharp source), `pad`, `pitch`, `frame`, colours `ink`/`paper`/`frameColor`; with no face it falls back to a centred box.

`objectDither`, `objectIsolines`, `objectSlitScan`, `objectCurtain`, `objectGrid` and `objectContour` also take `region` (`0` whole layer, `1` subject only, `2` background only) and `regionSoft`, which is what the field is for.

The rest of the fragment family: `objectSlitScan` slides strips of the picture — `dir` (`0` vertical, `1` horizontal), `count`, `shift`, `drive` (`0` subject field, `1` edge strength, `2` standing wave, `3` random), `hold` (high-weight strips stay put while the background shears), `gap`. `objectCurtain` extrudes contour colour along the frame — `dir` (`0` down, `1` up, `2` both), `density`, `length`, `width`, `threshold`, `colorMode`. `objectGrid` packs editorial modules — `program` (`0` editorial, `1` measure, `2` fragment, `3` data), `modules`, `protect` (subject modules stay large and open), `fill`, `gutter`, `open`, `weight`, `labels`. `objectContour` draws `method` `0` topographic level sets (`levels`) or `1` flow engraving (`density`, `drift`), with `detail`, `weight` and `subjectBias`.

Geometry look controls: `objectNodes` — `shape` (0–7, `8` mixed), `size`, `weight`, `fill`, `vary`, `random`, `rotate`, `hero`/`heroScale`/`ring`, plus `labels`/`labelStyle`/`labelSize` (Node Labels is this program's option, not a separate effect). `objectLinks` — `mode` (`0` proximity, `1` Delaunay, `2` edge chain, `3` radial hubs, `4` orthogonal, `5` hybrid), `dist`, `weight`, `conf`. `objectFacets` — `detail`, `maxSide` (drops the Delaunay hull slivers), `fill`, `shade` (`0` flat, `1` facing ramp, `2` monochrome), `edge`, `subject`. `objectMeasure` — `target` (`0` subject bounds, `1` face box, `2` whole layer), `pad`, `corners`, `dims`, `cross`, `readout`, `weight`.

### Regular-layer Overlay Effects example

```json
{
  "id": "title-item",
  "clipId": "title-clip",
  "trimStart": 0,
  "trimEnd": 4,
  "effects": [
    {
      "id": "halftone",
      "eid": "title-halftone",
      "enabled": true,
      "mix": 70,
      "params": {},
      "clip": true
    },
    {
      "id": "glow",
      "eid": "title-glow",
      "enabled": true,
      "mix": 85,
      "params": { "intensity": 1.2, "threshold": 0.5, "radius": 24, "color": "#69e7ff" },
      "clip": false
    }
  ]
}
```

### Adjustment-layer Overlay Effects example

An adjustment clip is synthetic. Put its channel after the channels it should affect, but before the camera channel:

```json
{
  "clips": [
    { "id": "adj-clip", "source": "LOCAL", "mediaType": "adjustment", "url": "", "proxyUrl": null, "name": "Look", "duration": 6 }
  ],
  "channels": [
    { "id": "footage", "name": "Footage", "visible": true, "items": ["..."] },
    {
      "id": "look-channel",
      "name": "Look",
      "visible": true,
      "unsnapped": true,
      "items": [{
        "id": "look-item",
        "clipId": "adj-clip",
        "freeStart": 0,
        "trimStart": 0,
        "trimEnd": 6,
        "effects": [
          { "id": "vignette", "eid": "look-vignette", "enabled": true, "mix": 65, "params": {} },
          { "id": "grain", "eid": "look-grain", "enabled": true, "mix": 35, "params": {} }
        ]
      }]
    }
  ]
}
```

Channel order defines adjustment reach. `cameraLocked` changes camera behavior, not effect reach.

### Overlay Effect keyframes

Overlay Effects use `fx:<eid>:<parameter>` tracks:

```json
{
  "propertyKeyframes": {
    "fx:title-glow:mix": [
      { "position": 0, "value": "0", "easing": "AE Smooth" },
      { "position": 25, "value": "100", "easing": "AE Smooth" }
    ],
    "fx:title-glow:radius": [
      { "position": 0, "value": "8", "easing": "Smooth" },
      { "position": 100, "value": "44", "easing": "Linear" }
    ]
  }
}
```

Mix and numeric params are keyframable. Colors, gradients, and selects are static. Remove an effect's `fx:<eid>:*` tracks when removing the effect.

### Real 3D on 3D model layers

On a `model3d` item, these Overlay Effects have a REAL 3D version that renders inside the model's own 3D pass — reading its surface normals, its position in its own space and its real depth — instead of filtering the flat picture the pass hands back:

`rgbSplit`, `pixelate`, `crtMatrix`, `halftone`, `objectDither`, `ascii`, `fractalNoise`, `fill`, `colorama`, `gradientBeam`, `gradientSweep`, `objectContour`, `objectCurtain`, `bloom`, `auraBlur`, `lightRays`, `neonGlow`, `linesDraw`, `edgeDetect`, `flashBlink`, `glitch`, `objectSlitScan`, `pixelStretch`, `shapeRulers`, `curves`.

- In `capabilities.json` these effects carry `real3dOnModels: true`; 3D-only params and options carry `model3d: true`.
- The 3D version runs only when the entry says `"real3d": true` AND its id is in the list. The editor sets it when one of these is ADDED to a model layer (the picker marks them **3D**); the card's **Render in 3D** toggle switches an entry between the two. Any other effect on a model stays on the flat chain.
- Same `params`, Mix, Active Range and `fx:<eid>:*` keyframes as the flat effect. `clip` and the Object family's tracking params are ignored in 3D — the model IS the subject.
- What changes in 3D, in short: patterns (Mosaic Layer grid, Pixel Matrix, Halftone, ASCII, Dither, Fractal Noise) are locked to the SURFACE and turn with the model; lighting effects (Halftone dot size, Fill's shading, Colorama, Flash) use the model's real light and normals; RGB Split re-films the model from two shifted cameras (real parallax); Bloom thresholds the displayed light but blooms the HDR light; Beam / Sweep / Contour / Glitch / Slit Scan / Pixel Stretch run along the MODEL's own axes; Neon Glow, Lines Draw and Edge Detect trace its real outline, creases and depth steps; Light Rays' origin sits in the model's box and the body occludes its own rays; Shape Rulers draws its real 3D bounding box; Curves applies to the HDR light in tone space. Bloom's Threshold / Soft Knee are judged on the displayed light (same meaning as the flat slider), and what blooms is the HDR light, so a strong highlight glows more than a clipped one.
- 3D-only values (hidden on a flat entry; turning **Render in 3D** off resets them): Colorama `input` `5` Height / `6` Depth / `7` Facing; Mosaic `grid` `2` **Voxels** (the model rebuilt from cubes on a grid in its own space — `size` is the cube size in px, the silhouette turns blocky too); Light Rays `source` `3` **Behind** (a light disc behind the body, rays escape round its silhouette); Flash Blink `lightAngle` (0–360°, default 135 — the side of the body the flash lands on).
- Light that leaves the silhouette (halos, streaks, the ruler box, RGB Split's copies) is composited at the model's centre depth, so it is occluded by — and occludes — other 3D layers like the model itself.
- Cost: nothing until a model carries one of these. The passes and their buffers load and allocate on first use.

### Installed effects (`local:<id>`)

Effect packages an agent built or the user imported (custom-effects skill (GreenLight Dash only))
apply exactly like the registry effects above, in the same `effects` list and both scopes:

```json
{ "id": "local:chromatic-drift", "eid": "fx-drift-1", "enabled": true, "mix": 100,
  "params": { "amount": 6, "angle": 0, "speed": 0.5, "tint": "#ffffff", "tintMix": 0 } }
```

- Discover them in `GET /api/video-editor/capabilities` → `effects.local`: each entry carries its
  params (keys, ranges, defaults, which are keyframable), `scopes`, the `renderer` it was written
  for and `installation.status`. Number params animate with `fx:<eid>:<param>` tracks, like any
  effect.
- Use one whose `installation.status.state` is `ok`. `error` means it does not draw (the message
  says why); `unchecked` means no open editor has checked it yet.
- An installed effect draws on the engines it was written for: `renderer` is `webgl`, `webgpu` or
  `both`, against `GET /api/video-editor/engine`. On another engine it is skipped.
- An entry whose package is not installed on this machine is kept in the project as stored and
  skipped, so a project moves between machines without losing it; installing the package (or a
  bundle restore or web sync that carries it) brings it back. A plain board ZIP import installs no
  packages.

### Custom Overlay Effect (GLSL)

```json
{
  "id": "custom",
  "eid": "custom-wave",
  "enabled": true,
  "mix": 100,
  "params": {},
  "code": "void mainImage(out vec4 fragColor, in vec2 fragCoord) {\n  vec2 uv = fragCoord / iResolution.xy;\n  uv.x += sin(uv.y * 40.0 + iTime * 3.0) * 0.01;\n  fragColor = texture2D(iChannel0, uv);\n}"
}
```

- `code` is **GLSL**, Shadertoy-shaped: define `void mainImage(out vec4 fragColor, in vec2 fragCoord)`.
  The framework wraps it, seeds `fragColor` with the source pixel and applies Mix afterwards, so do
  not blend against the source yourself. The shader is compiled when the effect is created, and a
  body with no `mainImage` is rejected there.
- **Classic renderer only.** The body is compiled at runtime and no WebGPU renderer compiles GLSL, so
  when the app's engine is WebGPU (`GET /api/video-editor/engine`) the effect is skipped with a reason
  rather than drawn.
  The app also no longer offers it as a new effect: reach for the registry above, or build an
  installed effect (below), and treat this section as the contract for the entries existing
  projects already carry.
- Shadertoy names in scope: `iChannel0` (the isolated layer, or the below-stack composite on an
  adjustment layer), `iResolution` (vec3), `iTime`, `iProgress`, plus `iTimeDelta`, `iFrameRate`,
  `iFrame`, `iMouse` (always zero), `iDate`, `iChannelResolution[4]` and `iChannelTime[4]` for
  compatibility. There is no `iChannel1..3` — there is only one bound texture.
- The app's own uniforms, same values: `uTexture`, `uResolution` (vec2), `uTime`, `uProgress`, `uMix`,
  `uQuality`, `uParams[28]`, `uColor`, `uColors[5]`.
- `fxLocal(uv)`, `fxFrame(p)`, `fxDir(v)`, `fxRes()`, `fxAspect()`, `fxCoord(uv)` — geometry in the
  MOVING layer box. Without these an effect centres itself on the frame, so it stands still while the
  shape slides through it. On adjustment layers they reduce to frame space.
- Redeclaring any of those names in your own code is safe — the duplicate declaration is dropped from
  the prelude, which is what lets a shader pasted from elsewhere compile unchanged.
- `iTime`/`uTime` is clip-local seconds and restarts at 0 inside an active range (`start`/`end`).
- Keep output premultiplied-alpha safe near transparent edges.

## Layer Effects (`item.layerEffects`)

Layer Effects are an array of typed entries on regular visual items. Current ids:

- `runningGlow` — any visual layer; PRO-gated at render.
The three below are authored from the inspector's **DEPTH EFFECTS** section, not the Layer Effects picker — they share one depth map and that section owns it. They are still ordinary `layerEffects` entries in the data.

- `depthMap` — the depth SOURCE, image AND video layers. Renders nothing itself. Created by the section's **Analyse depth** button, not added as an effect. On video the map is FROZEN from one frame (the playhead's) and held for the whole clip.
- `depth3d` — image and video layers; 2.5D parallax driven by the project camera, reading the shared depth map.
- `depthScan` — image and video layers; a LiDAR-style slice through the shared depth map. Also `model3d` layers, where it slices EXACT depth and needs no map (`scnSpace`, below). FREE.
- `fresnelRim` — Fresnel Rim: light that hugs the subject's edges, read from its shape. `model3d` layers (the real surface rim, no map needed) and image/video layers (edges of the shared depth map, swept like Depth Scan). FREE.
- `motionBlur` — any visual layer except 3D models; smears the layer along its own transform motion.
- `motionTrail` — the same layer drawn again at its own past poses (or its past FRAMES); any visual layer except 3D models and camera-baked 3D plates. PRO-gated at render.
- `autoFill` — any visual layer (real 3D on models); geodesic "infection" fill. PRO-gated at render.
- `rig` — Rig (Puppet Pin) mesh warp on video/image/text/shape/motion layers; PRO-gated at render.
- `repetile` — repeats the layer into a grid of tiles with per-tile stagger; any visual layer except 3D models and camera-baked 3D plates.
- `regionDistort` — rescales only what is inside a rectangular band, the rest of the layer slides but keeps its shape; any visual layer except 3D models and camera-baked 3D plates.
- `bend` — AE's CC Bend It: rigid outside two axis handles, an arc between them; same layer scope as `regionDistort`.
- `cornerPin` — the layer box mapped onto an arbitrary quad by a projective homography; same layer scope as `regionDistort`. **Was an OVERLAY effect in 9.6.32 only** — an `item.effects` entry with this id migrates into `layerEffects` on load.
- `meshWarp` — a Catmull-Rom surface over a draggable lattice of up to 5x5 vertices; same layer scope as `regionDistort`.
- `bezierWarp` — four cubic edges driving a Coons patch, so the silhouette CURVES instead of kinking at a vertex; same layer scope as `regionDistort`.
- `droste` — the layer recursed INTO ITSELF (Escher's Print Gallery map); same layer scope as `regionDistort`. PRO-gated at render.
- `glass` — the shape becomes a pane of GLASS that refracts, frosts, tints and shadows the layers BEHIND it; `rectangle` / `ellipse` / `circle` shape layers only, FREE. It runs before the shape's own paint, so its order among the other entries does not change it.
- `chromaKey` — removes a backdrop of ANY colour (green, blue, red, white, black, grey) and makes the matte the layer's shape; video/image/sequence/grid layers, FREE.
- `mockupFrame` — draws a device chassis AROUND the layer and re-seats the layer's pixels in its screen; any visual layer except 3D models and camera-baked 3D plates. FREE.
- `layerMask` — one or more animatable vector masks that cut the layer's OWN pixels; video/image/text/shape/motion layers, FREE. On an **`adjustment` item** the same entry scopes the grade/effect chain instead: inside the masks the stack below is graded, outside it shows through untouched.

There can be at most one entry of each id. Each entry has a stable `eid`, an `enabled` flag, and a `params` object.

### Running Glow entry

```json
{
  "id": "runningGlow",
  "eid": "layer-running-glow",
  "enabled": true,
  "params": {
    "glowEdgeWidth": 4,
    "glowRadius": 34,
    "glowEdgeLevel": 1.6,
    "glowLevel": 1.3,
    "glowSpeed": 0.5,
    "glowCount": 2,
    "glowTrail": 52,
    "glowAmount": 100,
    "glowPathMode": 0,
    "glowTraceThin": 0,
    "glowMaskMode": 0,
    "glowHeadColor": "#ffffff",
    "glowTailColor": "#37d6ff",
    "glowGlowColor": "#1f6bff"
  }
}
```

Every numeric param keyframes as a same-name `propertyKeyframes` track (`glowAmount`, `glowEdgeLevel`, `glowLevel`, `glowRadius`, `glowAngle`, `glowEdgeWidth`, `glowOffset`, `glowStaticRim`, `glowSoftness`, `glowSpread`, `glowHeadGlint`, `glowCenterX`, `glowCenterY`, `glowTrail`, `glowFlicker`, `glowMaskThreshold`, `glowSourceLevel`) **except** `glowSpeed` (phase is `time × speed`, keying it would jump the light) and `glowCount` (an animated integer pops a whole runner per step). The static settings remain inside `params`.

For outline text, hairlines, or open paths set `glowTraceThin: 1` and choose `glowEdgeWidth` near the stroke width. For full-frame photos/video, alpha describes only the rectangular plate; set `glowMaskMode: 1` (luminance) to trace image brightness instead.

A text background bar (`textBgEnabled`), caption-bar border (`textBorderEnabled`), layer border or shadow can make the layer's silhouette a rectangle. Remove those decorations when the intended glow should trace the glyphs; keep them when it should trace a panel.

Works on `model3d` layers too — it traces the alpha contour of the texture the 3D pass hands back, exactly as it does for any other layer. (Capability data published before v9.0.6 omitted `model3d` from this effect's media types; that was wrong, and the editor never enforced it.)

### Build Depth Map entry

The depth SOURCE. Several effects sample the same estimate, so one entry owns it
rather than each carrying a copy of the same megabyte. In the editor this is the
**DEPTH EFFECTS** section's own Analyse / re-analyse button rather than a row in
any picker — an effect you can add that then does nothing until you run an
analysis is a worse affordance than a button that says so.

```json
{
  "id": "depthMap",
  "eid": "layer-depthmap-1",
  "enabled": true,
  "params": { "dmInvert": 0 },
  "depthMap": {
    "w": 384,
    "h": 216,
    "data": "data:image/png;base64,...",
    "t": 2.4
  }
}
```

- `depthMap` rides TOP-LEVEL on the entry (not inside `params`), so the project stays self-contained.
- `data` MUST start with `data:image/png;base64,` and `w`/`h` must be ≥ 2, or the map is dropped on load.
- `t` (video only, optional) — the SOURCE second the map was measured at. One map serves the whole clip; `t` only records which frame it describes, so the panel can name it and flag when the playhead has moved elsewhere. Images carry no `t`.
- `dmInvert` 0 = white is near (what the estimator produces), 1 = white is far. Every Depth effect on the layer obeys it, so they can never disagree about which end of the scene is close.
- This entry renders nothing on its own; `depth3d` and `depthScan` render nothing WITHOUT it. Write it alongside them.
- Do not invent a depth map. Generate it through the editor's **DEPTH EFFECTS ▸ Analyse depth** flow — the section opens on its **Add Depth Effect** picker, and the Analyse / Load block appears once a depth effect is on the layer (or a map already exists). On video, park the playhead on the frame to measure first, since the button reads that frame.
- **Projects written before this entry existed** keep their map on the `depth3d` entry and still work; the editor adopts it into the shared entry when Build Depth Map is added.

### 3D Depth entry

```json
{
  "id": "depth3d",
  "eid": "layer-depth-1",
  "enabled": true,
  "params": {
    "depthStrength": 100,
    "depthFocus": 45
  }
}
```

- Reads the `depthMap` entry's map. Renders nothing without one.
- Accepts the Overlay Effects **Active Range** — optional top-level `start`/`end` in clip-local seconds. Outside the window the strength is 0 (an exact bypass). It is a HARD edge; keyframe `depthStrength` for a gentle arrival. The timeline draws it as a coloured line under the clip, like a windowed Overlay Effect.
- `depthStrength` is 0–300%; `depthFocus` is 0–100%.
- Keyframe them with `propertyKeyframes.depthStrength` and `propertyKeyframes.depthFocus`.
- The effect uses the evaluated project-camera pose, including Camera Motion Paths, pan, tilt, and dolly. Lens-only `camZoom` intentionally produces no parallax.
- A `cameraLocked` channel does not receive camera-driven depth displacement.

### Depth Scan entry

A narrow slice THROUGH DEPTH, not a screen wipe: pixels whose depth is within
`scnWidth` of the moving threshold light up, so the contour crawls over the
subject's surface instead of marching across the frame.

```json
{
  "id": "depthScan",
  "eid": "layer-scan-1",
  "enabled": true,
  "params": {
    "scnSpeed": 83.33,
    "scnPhase": 4,
    "scnEase": 0,
    "scnWidth": 1.1,
    "scnSplit": 2.4,
    "scnFeather": 0.35,
    "scnGrain": 22,
    "scnPixel": 1,
    "scnColorMode": 0,
    "scnColor": "#b8ff52",
    "scnRamp": "linear-gradient(90deg, #001b2e 0%, #0aa6b8 40%, #b8ff52 70%, #ffffff 100%)",
    "scnGamma": 1,
    "scnLow": 1.5,
    "scnHigh": 99.5,
    "scnBorder": 100,
    "scnBrightness": 125,
    "scnSource": 0,
    "scnAmount": 100,
    "scnView": 0
  }
}
```

- Reads the `depthMap` entry's map. Renders nothing without one.
- Accepts the Overlay Effects **Active Range** — optional top-level `start`/`end` in clip-local seconds (NOT inside `params`), drawn on the timeline like a windowed Overlay Effect. Outside the window the pass is skipped entirely. Inside it the SWEEP CLOCK IS REBASED, so the slice starts at `scnPhase` wherever the window sits rather than being caught mid-travel; keyframe tracks stay on the clip clock.
- `scnColorMode` picks how the slice is coloured:
  - `0` **RGB Split** (default) — three slices at `phase − split` / `phase` / `phase + split`, which reads as chromatic fringing on the contour.
  - `1` **Flat Color** — one slice in `scnColor`. `scnSplit` is ignored.
  - `2` **Gradient** — one slice widened to `width + split`, with `scnRamp` laid across it far-to-near. `scnSplit` still means "how far the colours spread through depth".
  - `scnColor` is a hex string; `scnRamp` is a CSS `linear-gradient(...)` string, same form the gradient picker reads and writes.
- The sweep is a pure function of clip time: `phase = scnPhase + scnSpeed × seconds`, wrapped to 0–1. `scnEase: 1` (Hold Ends) applies a closed-form remap so it crawls at the extremes.
- `scnBorder` (0–100%) rejects the depth CLIFF at the subject's silhouette. At 0 the silhouette becomes a permanent outline that never moves, which reads as a filter rather than a scan.
- `scnView` `1` (Depth Map) and `2` (Original) are diagnostics that **render and export exactly as shown** — set it back to `0` before exporting.
- `scnAmount: 0` is a byte-exact bypass.
- Keyframable as same-name `propertyKeyframes` tracks: `scnPhase`, `scnWidth`, `scnSplit`, `scnFeather`, `scnGrain`, `scnGamma`, `scnLow`, `scnHigh`, `scnBorder`, `scnBrightness`, `scnSource`, `scnAmount`. `scnSpeed` is deliberately static (phase is `start + speed × t`, so an animated rate teleports the slice), as are `scnPixel` and the enums.
- **On a `model3d` layer** no `depthMap` entry is needed: the slice runs through the model's EXACT depth inside its 3D pass. `scnSpace` picks the axis — `0` Camera depth (distance from the camera across the model's own depth range, default), `1` / `2` / `3` a plane sweeping along the model's own X / Y / Z, so the line runs over the body however it is posed. `scnPixel`, `scnBorder` and `scnView` do nothing there.

### Fresnel Rim entry

Rim light from the subject's SHAPE. Authored from the DEPTH EFFECTS section.

```json
{
  "id": "fresnelRim",
  "eid": "layer-rim-1",
  "enabled": true,
  "params": {
    "frColorA": "#ff4fd8",
    "frColorB": "#7b3cff",
    "frIntensity": 5.2,
    "frWidth": 42,
    "frSoftness": 40,
    "frHalo": 1.2,
    "frBody": 25,
    "frPulse": 0,
    "frDirMix": 0,
    "frAngle": 0,
    "frAmount": 100
  }
}
```

- **3D model:** the real surface rim (1 − n·v from the model's own normals) inside its 3D pass, with its own even halo. It turns with the model and lights edges inside the outline too. No depth map. Fields: `frWidth` (rim width), `frSoftness` (hard band → raw falloff), `frBody` (0–100 %, the model's own light under the rim — 100 leaves it untouched; the presets dim it so the rim reads).
- **Image / video:** needs the `depthMap` entry. Only EDGES glow — wherever depth falls away behind a pixel — fading inward over `frRimPx` (px of a 1080-tall frame); `frEdgeMin` is the smallest depth drop that counts. Like Depth Scan, a window (`frWindow` ± `frFeather`) around `frPhase` picks WHICH depth's edges light, swept by `frSpeed` (%/s) with `frEase` (0 Linear, 1 Hold Ends); `frGamma`, `frLow`, `frHigh` shape the depth; `frBgDim` (0–100 %) dims what is not lit.
- Both: `frColorA` edge colour, `frColorB` falloff colour, `frIntensity` (0–6), `frHalo` (0–3, 0 skips the halo pass), `frPulse` %, `frDirMix` % with `frAngle` ° keep the rim to one side, `frAmount` (0 is an exact bypass).
- Presets (the inspector's): Backlight, Neon Edge, Ember, Glacier.
- Accepts the Active Range (top-level `start`/`end`). Keyframable: `frIntensity`, `frWidth`, `frHalo`, `frBody`, `frDirMix`, `frAngle`, `frPhase`, `frRimPx`, `frWindow`, `frAmount`.

### Motion Blur entry

```json
{
  "id": "motionBlur",
  "eid": "layer-motion-blur",
  "enabled": true,
  "params": {
    "mblurMode": 0,
    "mblurPhase": 0,
    "mblurShutter": 180,
    "mblurSamples": 24,
    "mblurMaxBlur": 120,
    "mblurFalloff": 250,
    "mblurAmount": 100
  }
}
```

- Smears the layer along its own motion, computed from the transform one timeline frame earlier: position/rotation/scale keyframes, Motion Paths, and parenting all contribute. Rotation produces correct per-pixel tangential streaks. A static layer is an exact bypass.
- `mblurMode` 0 = **Accumulation (true shutter, default)**: the layer is rendered at `mblurSamples` sub-frame positions inside the shutter window and averaged — physically correct; the whole per-layer pipeline (DoF/glow/Overlay chain) then styles the blurred plate. `mblurMode` 1 = **Velocity smear (fast)**: one gather pass that runs LAST, over the finished layer look; `mblurMaxBlur` and `mblurFalloff` apply only in this mode.
- `mblurPhase` places the shutter window: 0 = **Trailing (default)** — the whole streak lands BEHIND the motion with a crisp leading edge; 1 = Centered (symmetric); 2 = Leading (ahead). Applies to both modes.
- `mblurShutter` is exposure in degrees (0–720): 360° blurs across the full distance the layer moves between frames; 180° is a camera-like default. `mblurFalloff` (velocity mode): high ≈ flat physical shutter; low keeps a sharp core inside the streak (stylized smear).
- `mblurSamples` is used verbatim at render quality (halved during interactive playback only).
- Keyframe with `propertyKeyframes.mblurShutter`, `propertyKeyframes.mblurAmount`, and (velocity mode) `propertyKeyframes.mblurMaxBlur` / `propertyKeyframes.mblurFalloff`. `mblurSamples` is not keyframable — an animated tap count steps the kernel per integer.
- It cannot see motion INSIDE the clip's pixels (a person walking through a static video stays sharp) and does nothing on `model3d` layers.

### Posterize Time entry

```json
{ "id": "posterizeTime", "eid": "layer-posterize", "enabled": true, "params": { "ptFps": 12 } }
```

- The layer updates only `ptFps` times a second (1–60) while the project plays at full rate — the stop-motion /
  "on twos" look. It is the layer's CLOCK, not a pixel pass: its video or GIF frame, every keyframe (transform,
  effect params, masks, the motion path and Path Progress), text animators, a nested sequence's whole inner
  timeline, models and particles all hold on each step. Preview (paused and playing), `/render-still` and every
  export agree.
- **Not posterized:** the layer's sound, the timeline itself (which clip is active, cross transitions), layers
  parented to it or following it, and a camera clip.
- Keyframe the rate with `propertyKeyframes.ptFps`. The rate is INTEGRATED, so a ramp from 6 to 24 speeds the steps
  up smoothly and time never steps backwards.
- Costs nothing per frame beyond reading the time; a layer without it pays one array scan.

### Motion Trail entry

```json
{
  "id": "motionTrail",
  "eid": "layer-motion-trail",
  "enabled": true,
  "params": {
    "trailMethod": 1,
    "trailPersist": 96,
    "trailTaper": 1.6,
    "trailCount": 12,
    "trailSpacing": 1.5,
    "trailDecay": 88,
    "trailScale": -3,
    "trailRotate": 0,
    "trailOffsetX": 0,
    "trailOffsetY": 0,
    "trailBlend": 0,
    "trailColorize": 0,
    "trailTint": "#4fd6ff",
    "trailAmount": 100
  }
}
```

- **Motion Trail** (id `motionTrail`, PRO at render) draws the layer AGAIN at its own past poses. Same media list as `motionBlur` and for the same reason: both read the layer's screen-space box, which a camera-baked plate does not have.
- `trailMethod` decides where the extra copies come from, and it is a real trade rather than a quality setting:
  - `0` **Frame Echo** replays a ring of past PLATES, so it is the only method that carries motion from INSIDE the footage — a video, a talking head, per-glyph text animation.
  - `1` **Trail Buffer** (default) keeps one accumulator and erodes it `trailTaper` px per frame, for a continuous comet.
  - `2` **Transform Repeats** re-draws the CURRENT plate at past poses with no history at all, so it is exact at any instant and free to scrub.
- Frame Echo and Transform Repeats share `trailCount` (repeats, max 24) / `trailSpacing` / `trailDecay` and the drift set (`trailScale`, `trailRotate`, `trailOffsetX/Y`); Trail Buffer ignores those and uses `trailPersist` / `trailTaper` instead. Writing a value into the wrong half is silently inert, so set `trailMethod` first.
- `trailSpacing` is counted in 30fps timeline frames and may be fractional: small values give a continuous smear, large ones stepped ghosts.
- `trailScale` is a SIGNED per-repeat delta about the layer's own centre — `0` neutral, negative tapers to a comet, positive grows the tail.
- `trailBlend`: `0` Behind (trail under the layer) / `1` Add / `2` Screen / `3` Maximum. `trailColorize` (%) ramps the stack toward `trailTint`.
- Every method carries the FINISHED layer look (glow, defocus, the overlay chain, tiles) and follows the real motion path, parenting and follow rigs included.
- Frame Echo and Trail Buffer are temporal: a seek rebuilds them from reprojected poses, so a scrubbed frame is usable but can differ slightly from a sequential export on footage whose pixels move internally.
- Every number keyframes as a same-name `propertyKeyframes` track; the two selects do not.
- Compared with the `echo` OVERLAY effect: Motion Trail styles ONE layer's own pixels at a fixed point in that layer's pipeline; `echo` is a chain entry, so it can be ordered among other Overlay Effects, given an Active Range, and — on an adjustment item — applied to the whole composited stack below it.

### Grow Fill entry

```json
{
  "id": "autoFill",
  "eid": "layer-auto-fill",
  "enabled": true,
  "params": {
    "afSpeed": 25, "afProgress": 0, "afMode": 0, "afStyle": 1,
    "afRamp": "linear-gradient(90deg, #0d0503 0%, #a12708 40%, #ffc933 80%, #fff6d0 100%)",
    "afSoftness": 8, "afWavAmp": 18, "afWavScale": 36,
    "afFeWidth": 0, "afFeGlowW": 16, "afFeGlowI": 120, "afFeColor": "#ff9a3c",
    "afSeedMode": 6, "afSpeedType": 1, "afNoiseScale": 80, "afNoiseContrast": 60,
    "afBridges": 1, "afBridgeReach": 18, "afBridgeSlow": 2.5
  },
  "points": [{ "x": 0.15, "y": 0.5, "delay": 0 }, { "x": 0.8, "y": 0.5, "delay": 0.3 }]
}
```

- **Grow Fill** (id `autoFill`, PRO at render — free to preview) grows an "infection" fill through the layer's own alpha from infection points — the AutoFill-2-style reveal. The growth is GEODESIC: a CPU-baked arrival-time field travels through letterforms and around holes instead of wiping across them; **Bridges** (`afBridges`/`afBridgeReach`/`afBridgeSlow`) let it jump between disconnected letters with a time toll while paint still clips to the true alpha. Works on any visual layer. **On `model3d` layers the fill is REAL 3D**: the arrival field is baked geodesically over the mesh surface (welded across seams and touching parts) and rendered by injected materials, so the front creeps around the geometry and respects occlusion; manual seeds live in the entry's `points3d` array (`{x, y, z, delay}` in the model's root-local space, on the mesh surface). Speed-map Shape Flow/Combine degrade to Uniform/Turbulent on models; front/back edge px sliders map onto the normalised surface span.
- **`afProgress` (0–100 %) is the animation driver** — keyframe `propertyKeyframes.afProgress` 0→100 to play the fill. `afSpeed` also takes a track, and it is a RATE whose track is INTEGRATED over clip time (a ramp accelerates the front smoothly). The render-side shaping params keyframe too — `afSoftness`, `afWavAmp`, `afWavScale`, `afFeWidth`, `afFeGlowW`, `afFeGlowI`, `afBeOffset`, `afBeWidth`, `afBeGlowW`, `afBeGlowI` — they are plain shader uniforms and never touch the baked field. Bake-side params (seeds, speed map, bridges) deliberately are not keyframable: a keyed one would force a ~30 ms CPU rebake every frame.
- `afMode`: 0 Fill (paint over the layer), 1 Unfill (burn it away), 2 Reveal (fill as a matte). `afStyle`: 0 Solid (`afFillColor`) / 1 Gradient by Age (`afRamp` colours by time-since-arrival) / 2 Gradient Loop (`afRamp` + `afLoops`, `afFlow` — travelling wave bands) / 3 Noise Texture / 4 None (edges only).
- Front shaping: `afSoftness`, `afWavAmp`/`afWavScale`. **Front Edge**: `afFeWidth` crisp band, `afFeColorMode` 0 Solid (`afFeColor`) / 1 Gradient (`afFeRamp` across the band), `afFeGlowW`/`afFeGlowI` additive glow. **Back Edge** (`afBeEnable` 1): trailing band `afBeOffset` px behind the front with `afBeWidth`/`afBeColorMode`/`afBeColor`/`afBeRamp`/`afBeGlowW`/`afBeGlowI`.
- **Infection points**: `afSeedMode` 0 Left / 1 Center / 2 Right / 3 Top / 4 Bottom / 5 Scatter (procedural, with `afSeedCount`/`afSeedSeed`/`afSeedStagger`) or **6 Manual** — the entry's top-level `points` array (`{x, y, delay}`, layer-box 0..1 with y down, delay 0..1 staggering that point's start; max 32). Speed maps: `afSpeedType` 0 Uniform / 1 Turbulent Noise (`afNoiseScale`/`afNoiseContrast`/`afNoiseSeed`) / 2 Shape Flow (`afContourBias`) / 3 Combine.
- 14 presets (Ink, Glow Sweep, Electric, Fire, Ocean Wave, Neon Gradient, Neon Edge, Scan Sweep, Echo, Magic Mist, Handwriting, Frost, Burn Out, Disintegrate). Glow is additive — over white content it reads best in Reveal/Unfill modes or over a dark fill. Look-dev source of truth: `html/finished/autofill-lab.html`.

### Rig (Puppet) entry

```json
{
  "id": "rig",
  "eid": "layer-rig-1",
  "enabled": true,
  "params": {
    "rigDensity": 24,
    "rigExpansion": 1,
    "rigWeights": 0,
    "rigStiffness": 1.2
  },
  "pins": [
    { "pid": "p1", "type": "advanced", "name": "Advanced 1", "x": 0.0, "y": -0.28 },
    { "pid": "p2", "type": "position", "name": "Position 1", "x": 0.2, "y": 0.1 },
    { "pid": "p3", "type": "advanced", "name": "Advanced 2", "x": 0.35, "y": 0.3 },
    { "pid": "p4", "type": "starch", "name": "Starch 1", "x": -0.2, "y": 0.2, "amount": 100, "extent": 16, "hardness": 50 }
  ],
  "chains": [
    { "cid": "c1", "joints": ["p1", "p2", "p3"], "bend": 1, "preserveTex": true, "fleshR": 8 }
  ]
}
```

- **Rig (Puppet)** (id `rig`, PRO at render) is the After Effects Puppet Pin analog: a rigid moving-least-squares mesh warp of the layer's projected plate. Every pin both POSES and HOLDS its region — a pin you never animate is an anchor. Works on `video`, `image`, `text`, `shape`, and `motion` layers (not models, sequences, grids).
- **Pins live top-level on the entry** in unit-box coords (±0.5 of the layer box, y down — the `shapePath` convention), so they ride the artwork through move/scale/rotate, parenting, keyframes, and the project camera. `pid` must match `^[A-Za-z0-9_-]{1,24}$`, one entry per pid, max 64 pins.
- Pin `type`: `position` (moves), `advanced` (moves + rotate/scale ring), `bend` (rotate/scale about a HELD point), `starch` (stiffens a region — `amount` 0–100 %, `extent` in % of the box height, `hardness` = the fully-rigid plateau fraction).
- **Pose animates via `rig:<pid>:<chan>` keyframe tracks**, never by editing pin rest coords: channels are `x`/`y` (OFFSETS from rest in % of the layer box; 0 = at rest), `rot` (degrees), `scl` (%, 100 = neutral), `amount` (%; starch only). Channels valid per type: position `x,y`; advanced `x,y,rot,scl`; bend `rot,scl`; starch `amount`. Tracks for a deleted pin are dropped on load. "Reset pose" = delete the `rig:` tracks.
- Params: `rigDensity` = mesh cells across the box's longer side (8–48), `rigExpansion` dilates the alpha-clipped grid, `rigWeights` 0 Geodesic (disconnected islands stay independent — two legs don't drag each other) / 1 Euclidean, `rigStiffness` = weight falloff exponent (higher = more local).
- Every pin is animated from birth (AE-style): it carries `rig:` tracks from the moment it exists. Look-dev sources of truth: `html/rig-tool-lab-v2.html` and `html/rig-tool-app-mock.html`.
- **IK limbs** (`chains`): `{ cid, joints: [rootPid, elbowPid, endPid], bend: ±1, preserveTex, fleshR }` — max 8, each pin in at most one limb, joints must be existing non-bend/non-starch pins (chains referencing missing pins dissolve on load). Limbs are pure AUTHORING assists: a 2-bone solve runs only while a member pin is being posed and writes the joints' `rig:` tracks — playback and export never run a solver. Bone lengths and all render-side geometry derive from the joints' REST pins. What DOES run at render time is deterministic: rigidity samples along each bone keep the flesh from candy-wrapping, an Advanced root/end ring inherits its bone's rotation, and `preserveTex` (with `fleshR`, % of box height) binds nearby flesh rigidly to its bone so texture stops smearing on strong poses. **To animate a limb from the API, do not solve IK — just write the joint pins' `rig:<pid>:x|y` offset tracks directly** (bone lengths are respected only when the values came from the editor's solve; arbitrary offsets simply stretch the limb like plain pins).

### Repetile entry

```json
{
  "id": "repetile",
  "eid": "layer-repetile",
  "enabled": true,
  "params": {
    "repLeft": 2, "repRight": 2, "repUp": 1, "repDown": 1,
    "repSpacingX": 100, "repSpacingY": 100,
    "repMode": 0, "repEdgeMode": 2, "repClipCell": 0,
    "repOrder": 0, "repScale": 100, "repRotateStep": 0,
    "repReveal": 100, "repRevealType": 0, "repRevealOriginal": 1,
    "repSpread": 60, "repDelay": 0, "repAmount": 100
  }
}
```

- Repeats the layer into a grid that extends past the layer's own edges, laid out in the layer's OWN box space — a rotated or scaled layer tiles along its own axes, and `repRotate` is clockwise-positive like the item's own Rotation. The `repLeft`/`repRight`/`repUp`/`repDown` counts (0–20 each) add tiles in each direction from the original (Down really is down the screen), which stays exactly where the transform put it; the grid is therefore `(1+left+right) × (1+up+down)` tiles, capped at 41 × 41. The counts are **keyframable and read fractionally** — `2.4` is two full rings plus a third at 40% opacity — so a `0 → 5` track grows the field ring by ring instead of stepping.
- `repMode` picks the tiling: `0` Repeat, `1` Unfold (mirror both axes — every seam matches, the mode to use on non-tileable artwork), `2` Mirror H, `3` Mirror V, `4` Brick H (odd rows shift by `repBrick` %), `5` Brick V (odd columns shift — half-drop), `6` Brick + Mirror, `7` Pinwheel (each tile rotated 90° × ((col+row) mod 4)).
- `repMode` `8`–`11` are LAYOUTS rather than tilings: they keep the same tile set the Expand counts describe and place it on a figure instead of a grid — `8` Radial (one ring per grid ring, evenly spaced around it, elliptical when Spacing X ≠ Y), `9` Wave (the grid riding a sine on Y), `10` Spiral (phyllotaxis — √k radius, golden-angle divergence), `11` Random (scatter over the field's extent, reproducible from `repSeed`). The original stays at the centre of every figure, so switching layouts never moves the artwork. `repLayoutSpread` (%, 0–400) sizes the figure — 100 puts the outermost tile where the grid's outermost ring would have been — and `repLayoutTurns` (−12…12) is spiral turns, wave cycles across the field, or a whole-turn rotation of the rings. `repLayoutOrient: 1` turns each tile to face along the figure (out from the centre, or along the wave's tangent). Every figure is ABSOLUTE in the tile's own coordinate, never normalised by the drawn extent, so a keyframed Expand grows a ring without re-placing the tiles already on screen. Mirror flips and brick offsets do not apply in these modes.
- `repBounds` decides what one tile IS. `1` **Content (default)** measures the tight alpha bounds of the layer's own raster, which is what you want on `text` and `motion` layers: those draw into a composition-sized plate, so the raw layer box is the whole frame and tiling it produces a single frame-sized tile with the neighbours off-screen. `0` **Layer plate** tiles the full quad including its empty margin. Opaque media is unaffected either way — its plate already is its content.
- `repSpacingX`/`repSpacingY` are the grid PITCH as a % of the layer box (5–1000): 100 = tiles touch, above = gaps, below = overlap. They never resize the artwork. `repScale` (1–800) is the only thing that does — a tile is the layer at `repScale`, so 50 draws each copy at half size on the same pitch, and `repScaleFall` (−200…500) ramps that across the field. `repClipCell: 1` clips every tile to its cell (true CC RepeTile); `0` lets rotated or oversized tiles overlap. `repEdgeMode` decides what a tile shows where it reaches past the layer box (`0` Repeat, `1` Mirror, `2` Clamp, `3` Transparent) and only matters once `repBlendBorders` or a large `repScale` pushes past the cell.
- Per-tile stagger is the reason to reach for this over a duplicated layer. `repOrder` (`0` Columns, `1` Rows, `2` Diagonal, `3` Radial, `4` Random, `5` Columns mirrored) chooses the index everything else counts along. `repRotateStep` adds its angle ONCE PER TILE, so the field fans out from the original instead of turning as a block; `repScaleFall` and `repOpacityFall` ramp across the field; `repRotateRnd`/`repScaleRnd`/`repOpacityRnd`/`repJitterX`/`repJitterY` scatter it, all reproducible from `repSeed`.
- `repReveal` (0–100) is the entrance and the param to keyframe: each tile arrives after a delay set by `repSpread`, starting from `repFromScale`/`repFromRotate`/`repFromOffset` and easing in with `repEase`. `repReveal: 0` with `repFromScale: 0` draws nothing, so a single 0 → 100 pair is a full grid build-on.
- `repRevealType` is the pose a tile arrives FROM, and the From fields shape it further: `0` Fade (opacity only — with the default From values this is exactly the historical entrance), `1` Pop (starts at 15% scale and overshoots on the scale channel whatever easing is picked), `2` Rise (starts half a layer-height below), `3` Spin (starts at 40% scale, turned 180°), `4` From Center (the tile collapses onto the original's own centre and travels out to its cell, so the field blooms from the artwork). All five land on exactly the same finished field at `repReveal: 100`.
- `repRevealOriginal` decides whether the layer itself joins the entrance. `1` (default, and what the effect always did) means `repReveal: 0` hides the layer along with every copy — the field builds on from nothing. `0` means the entrance belongs to the COPIES: the original tile sits it out at full opacity in its finished pose, so the layer the user positioned never blinks.
- `repScrollX`/`repScrollY` (px/s at 1080p reference) drift the whole field for a seamless scrolling pattern; `repWaveAmp` with `repWaveAxis`/`repWaveLength`/`repWaveSpeed` runs a travelling wave through the per-tile Y, X, radial offset, rotation or scale.
- `repDelay` (0–60 frames at a nominal 30fps, `0` = off) lags each tile's PICTURE behind the layer's own along the stagger order, so a grid of a video plays as a canon rather than in lockstep: the head of `repOrder` plays live and its tail lags by the full delay. It is the one repetile control that is not a pure function of time — it replays a ring of 16 recorded half-res plates, the same machine as Motion Trail's Frame Echo, so it fills in during playback and export while a fresh seek shows the live frame until the ring catches up. Long delays are spanned by recording every Nth frame rather than by more VRAM. While it is on, every tile reads the ring (including the undelayed ones) so the field is uniformly soft, and tiles layer by delay first and `repStack` second. Not keyframable, for the same reason `repWaveSpeed` is not: it is a slot lookup, so a moving value would jump rather than accelerate.
- `repTint`/`repTintAmount`/`repTintMode` colour tiles across the field, `repBlendMode` (`0` Normal, `1` Add, `2` Screen) composites them, and `repStack` orders the draw so overlapping tiles layer the way you want.
- It runs AFTER the layer's Overlay Effects chain and Running Glow and BEFORE Motion Blur, so each tile carries the layer's finished look (glow, defocus and chain included) rather than each tile being styled separately.
- `repAmount` is the master: it fades the ADDED tiles only, leaving the original at full opacity, and `0` is an exact bypass. Keyframe `propertyKeyframes.repReveal`, `repAmount`, `repScale`, `repScaleFall`, `repScaleRnd`, `repRotate`, `repRotateStep`, `repRotateRnd`, `repOpacityFall`, `repOpacityRnd`, `repJitterX`, `repJitterY`, `repSpacingX`, `repSpacingY`, `repBrick`, `repBlendBorders`, `repWaveAmp`, `repWaveLength`, `repSpread`, `repFromScale`, `repFromRotate`, `repFromOffset`, `repTintAmount`, `repScrollX`, `repScrollY`, `repLeft`, `repRight`, `repUp`, `repDown`, `repLayoutSpread`, `repLayoutTurns`. **`repScrollX`/`repScrollY` are RATES whose tracks are INTEGRATED over clip time** (like `afSpeed` and Neon Glow's `pathSpeed`): a ramp accelerates the field smoothly instead of teleporting it when the rate changes. `repWaveSpeed` is a rate too and is deliberately NOT keyframable for the same reason `glowSpeed` is not — its phase is a plain `time × speed`, so keying it would jump rather than accelerate. `repSeed` is not keyframable either: a changed seed re-rolls every random draw, so an animated one strobes — but growing the grid does NOT re-roll anything, because each tile's random draws are hashed from its own position in the field, so tiles already on screen hold their jitter, scale and rotation while new rings fade in.
- Not available on `model3d` layers or camera-baked 3D plates: they come back from the 3D pass on a neutral full-frame quad, so there is no layer box to lay a field out in.

### Region Distort entry

```json
{
  "id": "regionDistort",
  "eid": "layer-region-distort",
  "enabled": true,
  "params": {
    "dsRegX": 50, "dsRegY": 19, "dsRegW": 84, "dsRegH": 28,
    "dsScaleX": 100, "dsScaleY": 155, "dsFeather": 3, "dsKeepSize": 0
  }
}
```

- Rescales only what is inside the band; outside it the layer slides to make room but keeps its own shape — the "stretch the word, not the burger" tool. The map is a per-fragment inverse, so nothing is resampled twice.
- **All geometry is PERCENT OF THE LAYER BOX with +y DOWN**, not the frame: the band rides the layer through move/scale/rotate/parenting. `dsRegX`/`dsRegY` are the band CENTRE (−50…150), `dsRegW`/`dsRegH` its size (1…200).
- `dsScaleX`/`dsScaleY` (10…400 %) are the stretch. **Both at 100 is an exact bypass** — the pass is skipped entirely unless a `dsScaleX`/`dsScaleY` keyframe track exists, so a keyed ramp away from neutral still runs.
- `dsFeather` (0.2…35 %) is how gradually the stretch hands back to the untouched part. `dsKeepSize` `0` lets the layer grow past its bounds, `1` rescales the result back into the original box.
- Keyframe `propertyKeyframes.dsRegX`, `dsRegY`, `dsRegW`, `dsRegH`, `dsScaleX`, `dsScaleY`, `dsFeather` — plain numbers, so the on-canvas band and the panel fields write the same values. `dsKeepSize` is not keyframable (it switches maps).
- Runs after the layer's Overlay Effects chain and Running Glow, before Bend and Repetile. Not available on `model3d` layers or camera-baked 3D plates — they come back on a neutral full-frame quad with no layer box to warp in.

### Bend entry

```json
{
  "id": "bend",
  "eid": "layer-bend",
  "enabled": true,
  "params": {
    "bnAX": 50, "bnAY": 72, "bnBX": 50, "bnBY": 24,
    "bnAngle": 45, "bnStretch": 100
  }
}
```

- After Effects' CC Bend It: everything outside the two axis handles stays rigid, and the span between them bends around an arc. A forward vertex warp over a 128² grid, which is why it is its own effect rather than a mode of `regionDistort` (an inverse fragment map) — they share no parameter, and a layer may carry both.
- `bnAX`/`bnAY` (handle A) and `bnBX`/`bnBY` (handle B) are PERCENT OF THE LAYER BOX with +y DOWN, −50…150, same convention as `regionDistort`.
- `bnAngle` (−180…180°) is how far the span arcs; `bnStretch` (20…300 %) lengthens the span along its own axis so the rigid ends slide apart instead of scaling. **`bnAngle: 0` with `bnStretch: 100` is an exact bypass** unless one of those two channels is keyframed.
- Keyframe `propertyKeyframes.bnAX`, `bnAY`, `bnBX`, `bnBY`, `bnAngle`, `bnStretch`.
- With `regionDistort` on the same layer the region stretch runs FIRST and the bend arcs the already-stretched artwork. Same media scope and same 3D exclusions as `regionDistort`.
- A legacy single `distort` entry (the two warps behind one `dsType` selector) migrates on load: `dsType: 1` becomes a `bend` entry with its `ds`-prefixed axis params renamed to `bn*`, anything else becomes `regionDistort`. Write the split ids, not `distort`.

### Corner Pin entry

```json
{
  "id": "cornerPin",
  "eid": "layer-corner-pin",
  "enabled": true,
  "params": {
    "cpULX": 12, "cpULY": 6, "cpURX": 88, "cpURY": 6,
    "cpLRX": 100, "cpLRY": 94, "cpLLX": 0, "cpLLY": 94
  }
}
```

- Maps the layer box onto an arbitrary quad through a TRUE projective homography, so parallel edges converge like a plane seen at an angle rather than stretching evenly. That perspective is why it is an inverse fragment map and not a forward vertex warp like `bend`: a forward warp interpolates affinely inside each triangle, which flattens exactly the convergence the effect exists to produce.
- The eight params are the corner positions in the winding UL → UR → LR → LL, as **PERCENT OF THE LAYER BOX** with +y down (−50…150, so a corner may sit outside the box). **`0,0 / 100,0 / 100,100 / 0,100` is an exact bypass**; `defaultParams` deliberately leans the top edge back so a freshly added effect shows what it does.
- All eight keyframe as `propertyKeyframes.cpULX` … `cpLLY`, which is how a pin tracks a moving surface. Because they are the layer's own box, the pin also rides move/scale/rotate/parenting for free.
- Anything outside the quad is transparent, and a degenerate quad (three collinear corners, or a corner dragged past the projective horizon) renders nothing rather than a mirrored ghost.
- Runs AFTER `regionDistort` and `bend` when a layer carries several, so the pin lays the already-warped artwork onto the plane. Same media scope and 3D exclusions as `regionDistort`.
- **Migration:** it shipped as an OVERLAY effect (`item.effects`) in 9.6.32 only. Such an entry is lifted into `layerEffects` on load, its 0–1 corner fractions (`ulX`…`llY`) rescaled to percent and its `fx:<eid>:<param>` tracks renamed to plain `cp*` ones. Write the layer-effect form.

### Mesh Warp entry

```json
{
  "id": "meshWarp",
  "eid": "layer-mesh",
  "enabled": true,
  "params": {
    "mwCols": 4, "mwRows": 4,
    "mwP0X": 0, "mwP0Y": 0, "mwP1X": 33.333, "mwP1Y": 0,
    "mwP2X": 66.667, "mwP2Y": 0, "mwP3X": 100, "mwP3Y": 0,
    "mwP4X": 0, "mwP4Y": 33.333, "mwP5X": 40, "mwP5Y": 20
  }
}
```

- After Effects' Mesh Warp: a Catmull-Rom surface over a control lattice, so dragging ONE vertex moves its neighbourhood and leaves the rest of the layer alone. FREE, same layer scope as `regionDistort`.
- The lattice is `mwCols` x `mwRows` (2–5 each) and its vertices are the numbered params `mwP<i>X` / `mwP<i>Y`, **percent of the layer box with +y down**, running left→right then top→bottom. Only the first `mwCols * mwRows` slots are live; the rest are inert and may be omitted.
- **Changing `mwCols` or `mwRows` RE-SEEDS the whole lattice** to a regular grid and drops any keyframe tracks on its vertices, because slot `i` means a different vertex at a different grid size. Choose the grid size first, then move points.
- Every live vertex keyframes, but its channels are published per layer rather than from the static registry — they appear in the Keyframe Builder only while the effect is on the layer.

### Bezier Warp entry

```json
{
  "id": "bezierWarp",
  "eid": "layer-bezier",
  "enabled": true,
  "params": {
    "bwULX": 0, "bwULY": 0,
    "bwT1X": 33.333, "bwT1Y": -20, "bwT2X": 66.667, "bwT2Y": -20,
    "bwURX": 100, "bwURY": 0,
    "bwR1X": 100, "bwR1Y": 33.333, "bwR2X": 100, "bwR2Y": 66.667,
    "bwLRX": 100, "bwLRY": 100,
    "bwB1X": 66.667, "bwB1Y": 80, "bwB2X": 33.333, "bwB2Y": 80,
    "bwLLX": 0, "bwLLY": 100,
    "bwL1X": 0, "bwL1Y": 66.667, "bwL2X": 0, "bwL2Y": 33.333
  }
}
```

- After Effects' Bezier Warp: four cubic edges driving a Coons patch, so the silhouette curves smoothly instead of kinking at a vertex the way a lattice does. FREE, same layer scope as `regionDistort`.
- Twelve points in a clockwise ring from upper left — corner, its two outgoing tangents, next corner, and so on — all **percent of the layer box with +y down**, and all keyframable as same-name tracks.
- The identity ring (a flat box with evenly spaced tangents, i.e. `bwT1Y`/`bwT2Y` at `0` and `bwB1Y`/`bwB2Y` at `100`) is an exact bypass. The registry defaults deliberately bend the layer into an arc so a freshly added effect shows what it does — **write the identity ring explicitly if you want it inert**.

### Droste entry

```json
{
  "id": "droste",
  "eid": "layer-droste",
  "enabled": true,
  "params": {
    "droR1": 32, "droR2": 100, "droShape": 100, "droFit": 0, "droStretch": 100,
    "droCX": 50, "droCY": 50,
    "droTwist": 0, "droSpin": 0, "droZoom": 0, "droTiling": 0,
    "droFade": 0, "droTintAmount": 0, "droTint": "#0b1436",
    "droDepthLimit": 0, "droVoidOpacity": 0, "droVoid": "#000000",
    "droZoomSpeed": 0, "droSpinSpeed": 0,
    "droEdge": 0, "droQuality": 1, "droDetail": 0, "droAmount": 100
  }
}
```

- Recurses the layer into itself — Escher's *Print Gallery* map. The recursion is CLOSED FORM (a `mod` in log-polar space), so every level exists at once: there is no level count, and depth costs nothing.
- **`droR1` / `droR2`** are the annulus that repeats, as PERCENT OF THE LAYER BOX. Everything inside `droR1` is the next copy down; `droR2: 100` is the layer's own edge, which is the case where nothing is cropped. Only the band between them is ever sampled.
- **`droTwist` is LEVELS PER TURN.** `0` nests straight frames inside frames (the "infinite frame"); `1` is the classic Escher spiral; `2` braids two arms; negative winds the other way. **It is seamless only at WHOLE numbers** — a fractional twist leaves a real discontinuity on the 180° ray. That is a legitimate look, never an accidental one; do not write a fractional twist unless a cut is what is wanted.
- **`droShape`** morphs the nesting outline: `-100` diamond, `0` circle (the true conformal Droste), `100` the layer's own RECTANGLE. Use `100` for "the layer inside the layer" and `0` for a vortex. **`droFit: 1`** measures the shape against the SHORT side, so a circle stays round on a wide layer instead of becoming an ellipse; `droStretch` widens it on its x axis.
- **`droZoom` is measured in levels and ONE WHOLE LEVEL IS A CLOSED LOOP.** Keyframe it `0 → 1` (or `0 → -1`) over the clip and the endless zoom repeats seamlessly. `droSpin` is degrees.
- **`droZoomSpeed` (levels/s) and `droSpinSpeed` (°/s) are RATES and are deliberately NOT keyframable** — a track on a rate makes the phase jump every time the rate changes. Animate `droZoom` / `droSpin` instead. Every other number keyframes as a plain `propertyKeyframes.dro*` track.
- **`droDepthLimit` is the COPY COUNT** (the panel calls it **Copies**; the key is historic). `0` is endless — the recursion costs nothing to continue, so it runs past anything the frame can resolve. An integer 1…20 draws exactly that many copies and cuts cleanly ON the level boundary, leaving a hole that `droVoid` at `droVoidOpacity` fills. A set count is a **FINITE STACK that runs BOTH WAYS** — N copies nesting inward and N growing outward, spanning copy index (−N, N). At rest the outward half is bigger than `droR2` and therefore off frame, so a still Droste is unaffected by it; it is what keeps the frame filled once a zoom carries the stack outward, instead of the copies shrinking to a speck on an empty frame. Because the stack is finite it **ENDS** rather than looping — grown past its span it has left the frame entirely. Use `droDepthLimit: 0` for the endless recursion that loops seamlessly.
- `droTiling: 1` mirrors every second level, which breaks self-similarity on purpose (the scale breathes instead of running away). `droFade` / `droTintAmount` + `droTint` shade by depth.
- `droQuality` is the tap budget (0 fast, 1 smooth, 2 best) — the centre of a Droste is infinitely fine, so taps are chosen per pixel from the local magnification and the last few pixels fade rather than alias. `droDetail` moves that threshold. `droEdge` handles a `droR2` past 100 (transparent / clamp / repeat / mirror, in BOX units).
- `droAmount: 0` is an exact bypass. Runs AFTER the four shaping warps and BEFORE `cornerPin`, so a recursed layer can then be laid onto a plane. Same media scope and 3D exclusions as `regionDistort`.

### Glass entry

Use this whenever a video needs glass: glassmorphism cards and buttons, a liquid-glass bar, frosted panels, a magnifier or lens over footage or type, crystal or prism tiles. Do not fake it with `backdropBlur` plus a white fill, an HTML clip with CSS `backdrop-filter`, or a generated video — none of them bends what is behind, and a stack of them does not refract itself.

A shape with a `glass` entry is a pane the compositor renders over the layers below it: they are bent through the pane's bevel or lens (refraction with spectral dispersion), frosted and tinted, the rim is lit and the pane drops a soft shadow on them. Panes stack: a glass shape higher in the timeline refracts, frosts and shadows the glass shapes under it, so overlapping cards and glass buttons on a glass bar work as real glass. The pane follows the layer's transform, keyframes and 3D rotation (`rotateX`, `rotateY`, the camera): a tilted pane shows its thickness as side walls.

```json
{ "shapeType": "rectangle", "shapeSizeUnit": "px", "shapeWidthPx": 760, "shapeHeightPx": 220, "borderRadius": 64,
  "shapeFillColor": "rgba(255,255,255,0)",
  "layerEffects": [{ "id": "glass", "eid": "layer-glass", "enabled": true, "params": { "glassPreset": "liquid" } }] }
```

- `params.glassPreset` sets every parameter at once: `liquid` (clear pane, curled edge — the usual choice), `frosted` (blurred milky pane), `slab` (thick crystal block with a small chamfer; walls show when tilted), `opal` (milky tile), `magnifier` (dome lens that enlarges), `fisheye` (concave lens that shrinks), `prism` (cut edge with a spectral split), `fluted` (reeded ribs), `hammered` (dimpled cast glass), `smoked` (dark tint), `etched` (sandblasted face inside a clear border), `gel` (tinted bubble). An unknown id loads as `liquid`. Turn the pane off with `enabled: false` (settings kept) or remove the entry.
- Send a transparent `shapeFillColor` with it. The fill draws on top of the pane, so an opaque fill hides the glass; a faint one tints it. `borderWidth` / `borderColor` draw a rim line over the pane.
- Only `rectangle` (with any `borderRadius`, per-corner radii included), `ellipse` and `circle` shapes take glass; other shape types, clip-mask shapes and non-shape layers ignore the entry. The pane fades with the layer's `opacity`, keeps only what its `trackMatte` keeps, and is cut by its Layer Mask (a `layerMask` entry in the same `layerEffects` list): the masked-away part shows no glass and casts no shadow.
- Every param below is optional; one you leave out takes the preset's value when the project loads (and is stored from then on). Send only the ones you change. `%` sizes are of the shape's shorter side, so one preset reads the same on a button and on a full-width card.

| Param | Range | Meaning |
|---|---|---|
| `glassProfile` | `circle` · `squircle` · `chamfer` · `dome` · `concave` | Edge profile (round, squircle, flat cut), or a whole-pane lens: `dome` enlarges, `concave` shrinks |
| `glassBevel` | 0.5–40 % | Width of the bent edge band (the rim cap of a lens) |
| `glassHeight` | 0–50 % | Bevel height — how steep the edge is, so how strongly it bends |
| `glassDepth` | 0–50 % | Thickness under the bevel; shows as side walls on a tilted pane |
| `glassCorner` | 2–6 | Corner smoothing: 2 = circular corners, 4–5 ≈ continuous (squircle) corners |
| `glassIor` | 1–2.4 | Index of refraction (1.5 ≈ glass) |
| `glassDispersion` | 0–1 | Spectral split at the bent edges |
| `glassMagnify` | 0.5–2.5 | Extra zoom of what is behind the whole pane |
| `glassFrost` | 0–60 px | Blur of what is behind |
| `glassGrain` | 0–1 | Sandblasted grain in the frost |
| `glassClearBorder` | 0–20 % | Clear polished border around a frosted face |
| `glassPattern` | `none` · `fluted` · `hammered` · `ripple` | Surface pattern |
| `glassPatternScale` / `glassPatternDepth` / `glassPatternAngle` | 4–160 px / 0–40 px / 0–180° | Pattern size, relief and rotation |
| `glassTint` | `#rrggbb` | Glass colour |
| `glassTintAmount` / `glassTintDepth` | 0–1 / 0–1 | Tint strength; extra darkening through thick parts |
| `glassMilk` | 0–1 | Milky white scatter |
| `glassSaturation` / `glassBrightness` | 0–2 / −0.5–0.5 | What is behind, as seen through the pane |
| `glassEdgeShade` | 0–1 | Darkening toward the rim |
| `glassLightAngle` / `glassLightElevation` | 0–360° / 5–85° | Light direction: degrees counter-clockwise from screen right (120 = upper left), height above the pane |
| `glassSpecular` / `glassShininess` | 0–3 / 4–400 | Highlight strength / tightness |
| `glassRim` / `glassRimWidth` | 0–2 / 0.5–20 px | Lit rim line |
| `glassReflection` / `glassSoftness` | 0–1.5 / 0–1 | Studio reflection on the curved edge / how soft highlights and reflections are |
| `glassShadow` / `glassShadowBlur` / `glassShadowOffset` | 0–0.8 / 0–30 % / 0–20 % | The pane's shadow on what is behind |

Keyframe tracks named like the params: `glassIor`, `glassDispersion`, `glassMagnify`, `glassFrost`, `glassTintAmount`, `glassMilk`, `glassLightAngle`, `glassShadow` — e.g. `propertyKeyframes.glassFrost` frosts a pane in. Animate position, scale and rotation through the layer transform as usual; the refraction follows the pane.

### Chroma Key entry

```json
{
  "id": "chromaKey",
  "eid": "layer-ck",
  "enabled": true,
  "params": {
    "ckKeyColor": "#3fb14a", "ckMethod": 0,
    "ckBalance": 40, "ckAdapt": 40, "ckTolerance": 0.3, "ckLumaWeight": 0.5, "ckChromaGuard": 1.8,
    "ckGain": 115, "ckClipBlack": 8, "ckClipWhite": 70,
    "ckShrink": 0, "ckFeather": 0,
    "ckSpill": 100, "ckSpillBias": 30, "ckSpillLuma": 70, "ckSpillTintAmt": 0, "ckSpillTint": "#c9a58a",
    "ckWrapAmt": 0, "ckWrapWidth": 12, "ckWrapColor": "#ffe9c9",
    "ckView": 0, "ckAmount": 100
  }
}
```

- Keys out a backdrop of **any colour**, not only green. **`ckKeyColor` is the screen colour and must match the footage** — a generic green keys nothing on a blue or white plate, so never leave the default. Sample it from the media before writing the entry: fetch the file (or render a still — see `/render-still` in `video-rendering.md`) and average a patch of pixels near the frame border, which is where a screen shows and a subject usually does not.
- **`ckMethod: 0` (Auto) picks the keyer from the key colour** and is the right choice almost always: a saturated key runs **Colour Difference** (the Keylight family — the key hue is rotated onto green internally, so blue, red, magenta and yellow screens key exactly like green, and an unevenly lit cloth keys from one pair of clip levels); a very light or very dark key runs **Luma** (`ckTolerance` + `ckChromaGuard`); a mid grey runs **3D Colour Distance** (`ckTolerance` + `ckLumaWeight`). `1`–`4` force one (`1` diff, `2` chroma distance in CbCr, `3` luma, `4` 3D).
- Colour Difference controls: **`ckBalance`** compares the key channel against the stronger (`0`) or weaker (`100`) of the other two — **lower it to ≈35 when dark skin or a dark subject goes semi-transparent** on a yellow-green screen; **`ckAdapt`** scales the expected screen level by each pixel's brightness so a dark corner of the screen still reads as screen (raise toward `80` for a badly lit cyc).
- **Matte levels** apply to every keyer: `ckGain` multiplies screen-ness (raise to clear noise on the screen), `ckClipBlack` / `ckClipWhite` are the levels on the matte (raise Clip Black to clean the screen, lower Clip White to make the subject solid). Then **`ckShrink`** chokes the matte (negative erodes, positive grows — a grown matte reveals the source pixel, never a black fringe, and never past the layer box) and **`ckFeather`** softens it; both in **composition px**.
- **Spill**: `ckSpill` clamps the key hue out of the subject (screen light on edges and hair), `ckSpillBias` picks how much of the other channels' envelope survives, `ckSpillLuma` puts the removed brightness back as grey, and `ckSpillTintAmt` + `ckSpillTint` replace it with a colour instead. **Automatically off for a hue-less key** (white / black / grey) — there is no hue to remove.
- **Light wrap** (`ckWrapAmt`, `ckWrapWidth` px, `ckWrapColor`) tints the matte's edge with a colour — the colour of whatever will sit behind the layer. It is a colour, not the scene: a layer effect cannot see the layers below.
- **`ckView` renders into the output**: `1` writes the matte (grey), `2` a black / grey / white status view. Leave `0` (Result) in any project meant for export.
- `ckAmount: 0` is an exact bypass (`0`–`100` mixes with the unkeyed plate). Every number except the key colour and the two selects is keyframable as a plain `propertyKeyframes.ck*` track.
- Runs **FIRST** of all per-layer stages, in place on the isolated plate: masks, Rig, Grow Fill, DOF, Running Glow, the warps, Motion Blur / Trail and track mattes all see the keyed silhouette. Works on any `video` / `image` / `sequence` / `grid` layer, including camera-baked 3D plates (it reads pixels, not the layer box).
- Starting values that measured best against ground-truth mattes (all with the sampled `ckKeyColor`): coloured screen, fine hair → `ckGain 100, ckClipBlack 10, ckClipWhite 85`; dark subject on a yellow-green screen → `ckBalance 35, ckClipWhite 62`; compressed / webcam footage → `ckClipBlack 14, ckClipWhite 80, ckShrink -0.6, ckFeather 1.2`; unevenly lit cyc → `ckAdapt 80, ckGain 135, ckClipBlack 12`; white backdrop → `ckMethod 3, ckTolerance 0.38, ckChromaGuard 3, ckGain 120, ckClipBlack 14, ckClipWhite 85, ckSpill 0`; black backdrop → `ckMethod 3, ckTolerance 0.2, ckChromaGuard 2, ckGain 130, ckClipBlack 8, ckClipWhite 80, ckSpill 0`; grey backdrop → `ckMethod 4, ckTolerance 0.34, ckLumaWeight 1.4, ckGain 130, ckClipBlack 8, ckClipWhite 70, ckSpill 0`.

### Layer Mask entry

```json
{
  "id": "layerMask",
  "eid": "layer-mask-1",
  "enabled": true,
  "params": { "mskAmount": 100, "mskQuality": 0 },
  "masks": [
    {
      "mid": "m1", "name": "Mask 1", "mode": "add",
      "enabled": true, "inverted": false,
      "path": { "points": [
        { "x": 0, "y": -0.5, "hIn": { "x": -0.276, "y": 0 }, "hOut": { "x": 0.276, "y": 0 }, "manual": true },
        { "x": 0.5, "y": 0, "hIn": { "x": 0, "y": -0.276 }, "hOut": { "x": 0, "y": 0.276 }, "manual": true },
        { "x": 0, "y": 0.5, "hIn": { "x": 0.276, "y": 0 }, "hOut": { "x": -0.276, "y": 0 }, "manual": true },
        { "x": -0.5, "y": 0, "hIn": { "x": 0, "y": 0.276 }, "hOut": { "x": 0, "y": -0.276 }, "manual": true }
      ], "closed": true },
      "x": 0, "y": 0, "w": 70, "h": 70, "rot": 0,
      "feather": 0, "expand": 0, "opacity": 100, "grow": 0
    },
    {
      "mid": "m2", "name": "Mask 2", "mode": "subtract",
      "enabled": true, "inverted": false,
      "path": { "points": [], "closed": true },
      "x": 10, "y": 0, "w": 30, "h": 30, "rot": 0,
      "feather": 12, "expand": 0, "opacity": 100, "grow": 0
    }
  ]
}
```

- **Layer Mask** (id `layerMask`, FREE) cuts the layer's own pixels with one or more bezier masks. Available on `video`, `image`, `text`, `shape` and `motion` layers (not models, camera-baked 3D plates, or a sequence/grid CONTAINER — a mask inside a sequence or grid works, authored on the inner layer).
- **On an `adjustment` item the mask scopes the grade instead of cutting pixels**: inside mask coverage the layers below are graded/effected as usual, outside it the ungraded composite shows through — a MIX, not an alpha cut (an adjustment has no pixels of its own). Same entry schema, fold rule, keyframe tracks and `mskAmount` semantics (`mskAmount: 0` = mask off = grade everywhere). Works at the top level and inside a sequence. The mask box is a % of the adjustment plane's box, which spans the frame by default and follows the item's own transform/keyframes.
- **Framing follows the VISIBLE area.** On a masked `video`/`image`/`motion` layer the item's border (`borderWidth`/`borderColor`/`borderStyle`) and `shadows` are drawn along the masked shape (like a Chroma-keyed layer's), not around the rectangle the mask cut away; `shapeRulers` frames the bounds of what the mask leaves visible; `neonGlow` and `linesDraw` run along the visible outline. With `mskAmount` below 100 the cut-away part still shows, so these fall back to the whole layer. Shapes and text keep their own framing.
- **The masks ride top-level on the entry** in the `masks` array (the `pins` precedent), max 16. `mid` must match `^[A-Za-z0-9_-]{1,24}$`, one entry per mid.
- **Too many points?** A rotoscoped or traced outline is usually far denser than it needs to be. `POST /api/paths/smooth` reduces any of these point lists (see *Smoothing / reducing any path* in `video-paths.md`) — use `mode: "reduce"` plus `kept_indexes` when the mask path is keyframed, so every key loses the same points and the morph stays 1:1.
- Each mask's `path` is **byte-identical in shape to `item.shapePath`**: points in unit-box space (±0.5 = the edge of the mask's own box, +y DOWN), handles stored as offsets from their anchor. A mask always fills, so `closed` is always `true`. At least 3 points, else the mask is dropped on load.
- ⚠️ **Write `hIn`/`hOut` and `manual: true` on every anchor** — an absent or zero-length handle is a corner, and nothing auto-smooths a stored path (that pass runs only when a human drags a point), so a bare `x`/`y` list cuts a **polygon**. Smooth anchor = `hOut = (P[next] − P[prev]) / 6`, `hIn = −hOut`, wrapping at both ends since a mask is closed; a circular quarter-arc = `0.5523 × radius` perpendicular to the radius (`0.2761` in the ±0.5 box — the four-point circle above). Anchors and handles clamp to ±8. Ready-made outlines with handles resolved: `GET /api/video-editor/capabilities` → `paths.shapePresets` (see `video-shapes.md`).

| Field | Unit | Range | Meaning |
|---|---|---|---|
| `x`, `y` | **% of the layer box** | −300…300 | mask box offset from the layer centre |
| `w`, `h` | **% of the layer box** | 2…400 | mask box size |
| `rot` | deg | −1080…1080 | mask box rotation, inside layer space |
| `feather` | **composition px** | 0…500 | edge softness |
| `expand` | **composition px** | −500…500 | offset the edge outward (negative pulls in) |
| `opacity` | % | 0…100 | this mask's density in the fold |
| `grow` | **composition px per SECOND** | −10000…10000 | added to `expand` over the clip |

- **Units are load-bearing.** `x/y/w/h` are percentages of the LAYER box, not pixels and not raw unit-box fractions, so a mask rides layer resize/zoom/parenting. `feather`/`expand`/`grow` are COMPOSITION px (the `borderRadius`/`shadows` convention). This is a deliberate divergence from After Effects, which feathers in layer px so scaling a layer scales its feather.
- **`grow` is a RATE, not a distance.** Its track is INTEGRATED over clip time (like `afSpeed` and `repScrollX`), so a keyed ramp accelerates the edge smoothly instead of teleporting it. A constant `grow` needs no keyframes at all — it is a reveal on its own.
- **Keyframes ride `msk:<mid>:<chan>` tracks**, never edited stored fields: channels are `x`, `y`, `w`, `h`, `rot`, `feather`, `expand`, `opacity`, `grow` (numeric, same units as the table) plus **`msk:<mid>:path`, which is NON-SCALAR** — each key's value is a JSON point list, exactly like the shape layer's `shapePath` track. `mskAmount` is an ordinary registry track. Tracks for a deleted mask are dropped on load.
- ⚠️ **Every key of a `msk:<mid>:path` track MUST hold the same point count.** The morph blends point-by-point and clamps to the shorter list, so a mismatch silently corrupts the geometry. Any edit that changes the count (insert, delete, applying a preset at a different resolution) has to be applied to every key AND to the stored `path`.
- ⚠️ **A dense (per-frame / roto) `msk:<mid>:path` track must use `Linear` easing on every key** — the evaluator applies the LOW key's easing, so eased per-frame keys stutter at 30–60Hz. Key positions round to 4 decimal places (`roundKeyPosition`), which keeps adjacent frames distinct at 60fps.
- **RotoScope (video layers, in the Layer Mask panel section)** traces a subject (Person / Object / Colour modes, box region seed) and writes the whole outline animation as one `msk:<mid>:path` track on a mask named `Roto`, max 128 points, Linear keys, mask box = the media's contain-fit rect with x/y/w/h/rot never keyed. Auto-trace-this-frame is FREE; Track forward is PRO. Re-running replaces the `Roto` mask instead of adding another.
- **The fold rule.** The stack folds top-down in `masks` array order from an EMPTY base: `add` = `clamp(acc + m)`, `subtract` = `acc·(1−m)`, `intersect` = `acc·m`, `difference` = `acc + m − 2·acc·m`. **But if the FIRST enabled mask's mode is `subtract` or `intersect`, the base starts FULL instead** — otherwise a lone Subtract mask would blank the layer rather than cut a hole in it. A leading `difference` is treated as `add`. Order therefore matters: swapping two masks changes the result for Intersect and Difference.
- `mskAmount` (0–100 %, keyframable) mixes toward **no mask**: 0 leaves the layer untouched, 100 cuts fully. `mskQuality` 0 Fast / 1 High raises the coverage raster's resolution (a finer plate for wide feathers and hard edges under magnification).
- **Where it runs**: masks cut the layer's isolate BEFORE everything else on it — After Effects' order (Masks → Effects → Transform → Track Matte → Blend). So Running Glow traces the MASK edge, camera DOF gathers against the masked silhouette, "Clip to layer shape" clips to the mask, velocity Motion Blur smears the masked look, and a Track Matte still gets the last word. A layer can carry both a mask and a track matte, and they compose as AE does.
- Known limits: with ACCUMULATION motion blur the mask lands on the already-averaged plate (crisp edge, blurred content); Neon Glow's path FX still traces the UNMASKED outline; a masked-away region still occludes in the 3D depth pass; on split text the box is the whole mesh quad, so the mask cuts the plate uniformly.

### Mockup Frame entry

```json
{
  "id": "mockupFrame",
  "eid": "layer-mockup",
  "enabled": true,
  "params": {
    "mfDevice": "mbp16", "mfFinish": "", "mfOrient": "native",
    "mfSizeMode": 0, "mfFit": 70,
    "mfOffsetX": 0, "mfOffsetY": 0, "mfRot": 0,
    "mfMediaFit": 0, "mfMediaScale": 100, "mfMediaX": 0, "mfMediaY": 0,
    "mfMediaRot": 0, "mfMediaUpright": 1, "mfScreenBg": "#0b0d12",
    "mfScrollX": 0, "mfScrollY": 0, "mfScrollSpeedX": 10, "mfScrollSpeedY": 10, "mfScrollWrap": 0,
    "mfGlare": 35, "mfShadow": 55, "mfShadowBlur": 60,
    "mfShadowY": 26, "mfShadowSpread": 0,
    "mfStand": 1, "mfNano": 0, "mfBand": 1,
    "mfVariant": "safari", "mfTheme": "dark", "mfUrl": "greenlightdash.com"
  }
}
```

- Draws a device chassis AROUND the layer and re-seats the layer's own pixels in its screen. FREE. The chassis is PATH GEOMETRY re-drawn at the isolate's live pixel size, so a camera push finds more detail instead of a softer edge — which is why it holds up from 360p to 4K where a picture of a phone would not.
- `mfDevice` picks the chassis: `browser`, `iphone17`, `iphone17air`, `pixel`, `ipad13`, `mbp16`, `mba15`, `imac24`, `imacSpaceGrey`, `xdr`, `watch`. `mfFinish` picks a colour from that device's own list and is ignored by the single-finish frames.
- `mfSizeMode` `0` fits the whole chassis inside the layer box so nothing clips; `1` matches the chassis SCREEN to the layer box, which keeps the artwork at its original size and lets the chassis overflow — that is the case that wants `mfFit` around 70.
- `mfOrient` (`native` / `portrait` / `landscape`) rotates the chassis and carries its screen with it, exactly as real hardware does. `mfMediaUpright` (default `1`) counter-rotates the artwork and swaps the cover/contain box, so a portrait phone can still hold a landscape clip.
- `mfMediaFit`: `0` Cover / `1` Contain / `2` Stretch, with `mfMediaScale` / `mfMediaX` / `mfMediaY` / `mfMediaRot` placing the picture inside the screen and `mfScreenBg` filling what it does not cover.
- **Animated screen scroll.** `mfScrollX` / `mfScrollY` (0/1) add `speed × clip time` to `mfMediaX` / `mfMediaY`; `mfScrollSpeedX` / `mfScrollSpeedY` are % of the screen per second (+X moves the artwork LEFT, i.e. scrolls right; +Y moves it UP, i.e. scrolls down a page). The speeds are RATES: keyframed, the offset is the integral of the track, so a speed change never jumps. `mfScrollWrap` (0/1) tiles the artwork so a scroll never runs off into `mfScreenBg` — set it for an endless scroll; leave it 0 to scroll a tall screenshot once (use Cover fit + `mfMediaScale`).
- `mfVariant` (`safari` / `chrome` / `arc` / `minimal`), `mfTheme` (`light` / `dark`) and `mfUrl` apply to the `browser` chassis only. `mfStand`, `mfNano` and `mfBand` are per-device extras (0/1).
- The framed device is ONE image: the layer's own 3D tilt (`rotateX` / `rotateY`) keystones the chassis with the screen, and Mockup Frame runs FIRST in the geometry chain, so `regionDistort`, `bend`, `meshWarp`, `bezierWarp`, `droste`, `pryzm`, `cornerPin` and `repetile` on the same item reshape the whole device (listing order in `layerEffects` does not matter). With `mfSizeMode` `1` those stages work on the layer box grown to cover the overflowing chassis. A framed layer is rendered SEATED into the screen (the artwork's own pixels are moved into the chassis screen on the layer's plane before masks, fills, glow and overlay effects run), so those effects act on the seated artwork and a big or tilted layer never needs pixels outside the frame. Overlay effects that resample through the layer box (CRT Matrix, VHS), Layer Mask, Depth Scan and Auto Fill are exact on a 3D-tilted layer too — the box is the plane's projective map, not an affine frame (10.9.207).
- The numbers keyframe as same-name tracks; the selects and strings do not.
- Not the same thing as a **device mockup layer** — that is a rendered `video` clip carrying a `mockupConfig` (see `video-motion.md`). This is a layer effect on artwork you already have on the timeline.

### Complete regular-item example

```json
{
  "id": "photo-item",
  "clipId": "photo-clip",
  "effects": [
    { "id": "grain", "eid": "photo-grain", "enabled": true, "mix": 25, "params": {} }
  ],
  "layerEffects": [
    {
      "id": "runningGlow",
      "eid": "photo-runner",
      "enabled": true,
      "params": { "glowAmount": 80, "glowMaskMode": 1 }
    },
    {
      "id": "depthMap",
      "eid": "photo-depthmap",
      "enabled": true,
      "params": { "dmInvert": 0 },
      "depthMap": { "w": 384, "h": 216, "data": "data:image/png;base64,..." }
    },
    {
      "id": "depth3d",
      "eid": "photo-depth",
      "enabled": true,
      "params": { "depthStrength": 120, "depthFocus": 45 }
    },
    {
      "id": "depthScan",
      "eid": "photo-scan",
      "enabled": true,
      "params": { "scnColorMode": 2, "scnWidth": 1.4, "scnSplit": 3, "scnBrightness": 140 }
    }
  ]
}
```

## Adjustment-layer LUT

**Adjustment-layer LUT.** An `adjustment` item may carry a dedicated .cube colour LUT, separate from its `effects` chain, applied right after the layer's grade and before any stacked effects:

```json
{
  "lut": { "name": "Teal-Orange", "size": 33, "domainMin": 0, "domainMax": 1, "data": "<base64 RGB lattice>" },
  "lutAmount": 100
}
```

`data` is the parsed lattice (size³ RGB bytes, red-fastest order, base64; max size 33 — the editor resamples bigger .cube files on import), so the look is self-contained in the project JSON. `lutAmount` (0–100 %) is the intensity and is keyframable via a standard `lutAmount` track. **Don't author `data` by hand** — parse a real .cube file into the lattice, or copy a `lut` object from another item. On load, a malformed `lut` (wrong size/length) is silently dropped.

## Color Correction (`item.colorCorrection`)

A per-layer colour fix in the Lumetri mould for `video` and `image` items. It runs on the layer's own pixels inside its clip shader — before FILTERS, Layer/Overlay Effects, masks and the transition — so it costs no extra pass and appears identically in preview and every render. The stages always run in this order: **white balance → tone → levels → color → wheels → HSL**, then `mix` blends the result back over the original.

Use it, not the `filter*` fields, to fix a photo or clip: FILTERS are display-space multipliers that clip and shift hue, while this works in linear light, keeps hue when brightening, and carries per-channel levels for removing a cast. Keep FILTERS for stylised looks (sepia, invert, blur).

```json
"colorCorrection": {
  "enabled": true,
  "mix": 100,
  "wb": { "on": true, "temp": -40, "tint": 5 },
  "tone": { "on": true, "exposure": 0.6, "contrast": 15, "highlights": -30, "shadows": 20, "whites": 0, "blacks": -10 },
  "levels": {
    "on": true,
    "rgb": { "inB": 0, "inW": 255, "gamma": 1, "outB": 0, "outW": 255 },
    "r": { "inB": 4, "inW": 248, "gamma": 1.05, "outB": 0, "outW": 255 },
    "g": { "inB": 0, "inW": 255, "gamma": 1, "outB": 0, "outW": 255 },
    "b": { "inB": 0, "inW": 255, "gamma": 1, "outB": 0, "outW": 255 }
  },
  "color": { "on": true, "saturation": 110, "vibrance": 20 },
  "wheels": { "on": true, "shadows": { "x": 0.3, "y": -0.2, "l": 0 }, "midtones": { "x": 0, "y": 0, "l": 0 }, "highlights": { "x": -0.1, "y": 0.15, "l": 0 } },
  "hsl": { "on": true, "hue": [0, 0, 0, 0, 0, 0, 0, 0], "sat": [0, 0, 0, -30, 0, 15, 0, 0], "lum": [0, 0, 0, 0, 0, -20, 0, 0] }
}
```

- **White balance** — `temp` / `tint` −100…100 (0 = as shot). Positive `temp` warms (red up, blue down), negative cools; positive `tint` adds magenta, negative green. They are gains in linear light, luminance-preserving, eased so small values are fine adjustments and ±100 reaches an underwater-strength correction. To neutralise a colour cast, cool a warm (tungsten) picture with negative `temp`, warm a blue (shade, snow) one with positive.
- **Tone** — `exposure` −4…4 stops (linear light). `contrast`, `highlights`, `shadows`, `whites`, `blacks` −100…100 act on a hue-preserving brightness curve: lifting shadows does not shift colour. `highlights` below 0 also pulls values pushed past white back into range; `whites` / `blacks` move the white and black points.
- **Levels** — Photoshop levels on 0–255 values: per-channel `r` / `g` / `b` first, then the `rgb` master. `inB` < `inW` (kept ≥ 2 apart), `gamma` 0.1–9.99 (above 1 brightens the midtones), `outB` / `outW` the output range. Per-channel black/white points are the classic way to remove a cast.
- **Color** — `saturation` 0–200 (100 = unchanged, 0 = greyscale); `vibrance` −100…100 boosts the least saturated colours most and protects skin tones.
- **Wheels** — `shadows` / `midtones` / `highlights` each `{ x, y, l }`: `(x, y)` is a direction on the colour wheel inside the unit disc, laid out like a vectorscope (x = blue-yellow Cb axis, y = red-cyan Cr axis; red is up-left, blue right, green down-left); radius is strength. `l` (−100…100) lifts or lowers that tonal range.
- **HSL** — eight bands in this fixed order: Red, Orange, Yellow, Green, Aqua, Blue, Purple, Magenta (centred at 0°, 30°, 60°, 120°, 180°, 240°, 270°, 300°). `hue` shifts the band up to ±30°, `sat` scales its saturation (−100 = grey), `lum` darkens / brightens it. Greys are never affected.
- Each stage's `on: false` bypasses it and keeps its values; `enabled: false` mutes the whole correction; `mix` (0–100) blends it in.
- Omit the field (or leave everything at the defaults shown in the ranges above) for no correction — a layer without one costs nothing. On load, values are clamped to these ranges, and an object with nothing off its defaults is dropped.
- Every number is keyframable as a `cc:<path>` track in `propertyKeyframes` — `path` is the value's address inside the object (`cc:wb.temp`, `cc:tone.exposure`, `cc:levels.r.inB`, `cc:wheels.shadows.x`, `cc:hsl.sat.5`, `cc:mix`). A track overrides the static value, so an animated correction needs no stored `colorCorrection` at all; the `on` / `enabled` switches are not animatable. Example — a grade that warms up over the clip:

```json
"propertyKeyframes": {
  "cc:wb.temp": [
    { "position": 0, "value": "-30", "easing": "Smooth" },
    { "position": 100, "value": "40", "easing": "Smooth" }
  ]
}
```

## Render and editing rules

1. `GET` the project immediately before editing and preserve unrelated fields/channels.
2. Write Overlay Effects only to `effects`; write Running Glow and the Depth effects only to `layerEffects`.
   A Depth effect without a `depthMap` entry renders nothing — add the source alongside the consumer.
3. Keep every `eid` stable across edits and reorders.
4. Remove associated keyframe tracks when deleting an effect.
5. `PUT` the complete `data` object back with `expected_version` from the GET response. On 409, reload and reapply only the intended edit; never drop the version check.
6. Render with `/render-onserver` or the desktop renderer, never the fast `/render`.
