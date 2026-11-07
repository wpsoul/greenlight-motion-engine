> **GreenLight Motion Engine:** this is the GreenLight Dash Video Editor's project format, which the engine reads as is.
> Ignore the `/api/...` routes and the app UI described here: in the engine you edit `project.json` (or `apply`) and run
> `npx greenlight-motion build`; what `GET /api/video-editor/capabilities` returns there is `npx greenlight-motion schema <topic>`
> here. `frontend/src/…` paths are files of the engine's public source repository. MotionFast templates (`mediaType: "motion"`)
> stay in GreenLight Dash.

# GreenLight Dash — Backgrounds and custom shaders

> Part of the `greenlight-dash` skill. Read [video-projects.md](video-projects.md) for the shared project, clip, channel, timing and versioned-write contracts.

## Contents

- [Backgrounds (project & shape) — solid, gradient, shader, pattern, image](#backgrounds-project--shape--solid-gradient-shader-pattern-image)
  - [Background fields](#background-fields)
  - [Gradient and pattern ids](#gradient-and-pattern-ids)
  - [Shader presets](#shader-presets)
- [Custom GLSL shaders (project OR shape background)](#custom-glsl-shaders-project-or-shape-background)

## Backgrounds (project & shape) — solid, gradient, shader, pattern, image

Both the **project background** (the `background` field at the editor `data` root) and any **shape layer** (its `shapeBackground` item field — see [video-shapes.md](video-shapes.md)) take the same `backgroundConfig` object. Set `type`, then the fields for that type; fields of other types are ignored. Always set `solidColor` too: it is the base shown behind a shader or image while it loads, and the fallback when it fails.

A solid colour:

```json
{ "type": "solid", "solidColor": "#0b0b12" }
```

A gradient — a freeform CSS gradient (preferred) or a preset `gradientId`, optionally animated:

```json
{ "type": "gradient", "solidColor": "#0b0b12",
  "gradientCss": "linear-gradient(135deg, #ff6164 0%, #b00012 100%)",
  "gradientAnimated": true, "gradientAnimSpeed": 1 }
```

A shader preset with one of its looks and one colour changed. Leave `shaderCode` out: a preset id always runs the current preset source.

```json
{ "type": "shader", "solidColor": "#0b0b12",
  "shaderId": "silkdrift", "shaderLook": "graphite", "shaderParams": { "uGlint": "#ffe9c4" },
  "shaderSpeed": 1, "shaderScale": 1, "shaderZoom": 1 }
```

Your own shader (see [Custom GLSL shaders](#custom-glsl-shaders-project-or-shape-background)):

```json
{ "type": "shader", "solidColor": "#0b0b12", "shaderId": "custom",
  "shaderCode": "void mainImage(out vec4 o, in vec2 fc){ vec2 uv = fc / iResolution.xy; o = vec4(uv, 0.0, 1.0); }" }
```

A pattern:

```json
{ "type": "pattern", "solidColor": "#0b0b12", "patternId": "dots", "patternColor": "#ffffff", "patternScale": 100 }
```

An image, centred and covering the frame:

```json
{ "type": "image", "solidColor": "#0b0b12", "mediaUrl": "/media/admin/{board_id}/bg.jpg", "mediaType": "image",
  "bgFit": "cover", "bgPosX": 50, "bgPosY": 50, "bgRepeat": "no-repeat" }
```

`{ "type": "transparent" }` clears to nothing (alpha exports, overlay compositing). For a moving project background, use a normal full-frame video layer; for moving footage inside a shape, put the video below a shape clipping mask.

**Renderer reach.** In the mockup generator and HTML-card renderers a `type: "shader"` background falls back to `solidColor` and an animated gradient renders as a **static** gradient — **shaders and animated gradients render only inside the Video Editor** (and its full renders). Author those only where the target is a video project; elsewhere prefer `solid`, `gradient` (non-animated), `pattern`, or `image`.

### Background fields

| Field | Values | Meaning |
|---|---|---|
| `type` | `solid` · `gradient` · `shader` · `pattern` · `image` · `transparent` | Which fields below are read |
| `solidColor` | `#rrggbb` | The fill for `solid`; the base and fallback for every other type |
| `gradientCss` | CSS gradient string | Freeform gradient (preferred) |
| `gradientId` | a gradient id ([below](#gradient-and-pattern-ids)) | Used only when `gradientCss` is absent |
| `gradientAnimated` | `true` · `false` (default) | Loops by ping-pong panning the gradient |
| `gradientAnimSpeed` | 0.1–4, default 1 | Speed of that loop |
| `shaderId` | a preset id ([below](#shader-presets)) or `custom` | Which shader runs |
| `shaderLook` | a look id of that preset | Named colour set; resolves preset defaults → look → `shaderParams` |
| `shaderParams` | `{ "<uniform>": value }` | Per-preset tweakables: colours as `"#rrggbb"`, numbers as numbers; `{}` = defaults (or the look) |
| `shaderCode` | GLSL string | Runs only with `shaderId: "custom"` (see [Shader presets](#shader-presets)) |
| `shaderSpeed` | 0–30, default 1 | Multiplies the time fed to `iTime`; `0` freezes it |
| `shaderScale` | `1` · `0.5` · `0.25` · `0.125` | Render buffer: Full / Half / Quarter / Eighth detail |
| `shaderZoom` | 0.25–4, default 1 | Zooms the pattern around the frame centre; above 1 = bigger features |
| `patternId` | a pattern id ([below](#gradient-and-pattern-ids)) | Which pattern tiles |
| `patternColor` | `#rrggbb`, default `#ffffff` | Pattern colour, drawn over `solidColor` |
| `patternScale` | 10–500 (%), default 100 | Tile size |
| `mediaUrl` / `mediaType` | a board media URL / `"image"` | The picture |
| `bgFit` | `cover` (default) · `contain` · `custom` | How the image fills the frame or shape |
| `bgScale` | 10–400 (%), default 100 | Image size; read only when `bgFit` is `custom` |
| `bgPosX` / `bgPosY` | 0–100 (%), default 50 | Image position; `50` / `50` centres it |
| `bgRepeat` | `no-repeat` (default) · `repeat` · `repeat-x` · `repeat-y` | Tiling |

### Gradient and pattern ids

**Gradient ids** (`gradientId`): `sunburn`, `flamingo`, `aqua-lime`, `sunset-dusk`, `rose-mist`, `violet-dream`, `orchid`, `neon-punch`, `grape-soda`, `magenta-pop`, `tropic`, `spectrum`, `sky-deep`, `bubblegum`, `pastel-sky`, `ember-steps`, `blush-steps`, `earth-sea`, `indigo-sand`, `cotton-candy`. Prefer a freeform `gradientCss` for an exact look.

**Pattern ids** (`patternId`): `dots`, `grid`, `diagonal`, `zigzag`, `crosses`, `triangles`, `hexagons`, `diamonds`, `waves`, `circles`, `squares`, `stars`, `stripes-h`, `stripes-v`, `checkers`, `confetti`, `plus`, `arrows`, `hearts`, `noise`, `scallops`, `brick`, `leaf`, `spiral`, `cross-hatch`, `rings`, `fish-scale`, `moon`, `dashes`, `polka-ring`.

### Shader presets

Pick a preset `shaderId` by look, or use `custom` with your own `shaderCode`:

- **With a preset id, leave `shaderCode` out.** The render always runs the current preset source, so its `shaderParams` always reach the shader.
- **To run your own code, set `shaderId: "custom"`.** While `shaderId` names a preset, `shaderCode` is used only when its first line differs from the preset's, so an edited copy of a preset that keeps the preset's first line is silently replaced by the preset. Copying a preset's code into `custom` keeps working with the same `shaderParams`, because the copied code declares the same uniforms.

| `shaderId` | Name | Look | Mood / use | `shaderParams` (defaults reproduce the original look) |
|---|---|---|---|---|
| `silk` | Silk Flow | Domain-warped flowing gradient — four colours folding into each other like lit satin, no edges | Bright, premium, soft brand backdrop | `uColorA…uColorD` (colours; `#f4cd9f`, `#3162ee`, `#e882cc`, `#59b5f3`) |
| `glowblobs` | Glow Blobs | Soft drifting colour clouds over near-black, like out-of-focus neon | Dark, moody, text-friendly | `uColorA…uColorE` (blob colours: blue, violet, pink, orange, magenta), `uBgColor` background `#040406`, `uBlobSize` 0.4–2.5 |
| `waves` | Coral Waves | Ribboned warp-flow of coral / magenta bands with a golden highlight | Warm, energetic, fashion / summer | `uColorHot` `#ffd463`, `uColorMid` `#fa596b`, `uColorDeep` `#85178c` |
| `plasma` | Plasma | Classic smooth interfering sine waves cycling through a three-stop palette, fully bright | Retro / demoscene, playful | `uPlasmaScale` 1–10 (wave density), `uHueShift` 0–6.28 rad, `uColorA…uColorC` (`#ff8080`, `#80ff9a`, `#9a80ff`) |
| `mesh` | Mesh Gradient | Four drifting colour anchors blended into a soft mesh gradient, no visible edges | Modern SaaS / hero backdrop | `uColorA…uColorD` (`#fcd466`, `#f25973`, `#734dd9`, `#4dbff2`) |
| `fire` | Fire | Rising flames from the bottom edge with drifting sparks and smoke (port of Sjeiti's "Sparks drifting"); frame-normalised so it reads the same at any resolution | Dramatic, dark, heat | `uFlameTint` `#ffffff` (multiplies the whole flame), the flame ramp `uFlameOuter` edge `#ff0000` → `uFlameMid` `#ffff00` → `uFlameCore` `#ffffff`, `uSparkColor` `#ff4d00`, `uSmokeColor` `#ffffff`, `uBgColor` `#000000`, `uFlameHeight` 0.3–2.5, `uSparkAmount` 0–2 (0 = none), `uSmokeAmount` 0–2 |
| `spacetravel` | Space Travel | Radial starfield warp — stars streaming outward from centre, black space | Hyperspace / tech intro | `uStarColor` `#ffffff`, `uBgColor` `#000000`, `uStarSize` 0.5–8 (% of frame height), `uStarCount` 25–400 |
| `glitters` | Glitter Dust | Sparse twinkling points drifting upward over black (textureless port of "Simple magic glitters") | Luxury, festive, subtle | `uGlitterColor` `#ffffff`, `uBgColor` `#000000`, `uGlitterSize` 0.5–4, `uSparsity` 6–40 (higher = fewer points) |
| `blueplanet` | Blue Planet | A dark planetary limb lit by a thin rim and its blue atmosphere glow, black elsewhere | Sci-fi, cinematic, lots of dark space for text | `uTint` (white = original grade), `uRimColor` `#298cff`, `uRimHiColor` rim highlight `#99d1ff`, `uAtmoColor` `#2973f2`, `uSurfaceColor` lit band `#0b3b8f`, `uNightColor` night side `#010307`, `uBgColor` space `#040405` |
| `auroraridge` | Aurora Ridge | Luminous violet / lilac fog ridge rising over a black stage, a pink-to-warm-white wash along the bottom | Atmospheric, calm, dreamy | `uTint`, `uCrestColor` violet crest `#754df0`, `uFogColor` `#bdadfc`, `uCoreColor` fog core `#faf5ff`, `uEdgeColor` blue edge light `#2466ff`, `uFrontGlow` `#8c6bfc`, `uWashA…uWashD` bottom wash left → right (`#808adb`, `#a18ff2`, `#f5cceb`, `#ffede3`), `uSkyGlow` top-right glow `#080d2b`, `uBgColor` `#030306` |
| `emberpool` | Ember Pool | Warm orange-red footlight rising from the bottom into a black room, with a violet upper glow | Concert / stage, warm-dark | `uTint`, `uGlowA` upper glow `#4102ff`, `uGlowB` lower glow `#ff4c06`, `uGlowC` edge glow `#ff0b50`, `uGlowD` bounce `#ff3a0f` (hue only — HDR intensity is kept), `uBgColor` `#030107` |
| `neonvignette` | Neon Vignette | Rose and violet banked against the frame edges around a dark centre | Nightlife, product on dark, framed layouts | `uTint`, `uGlowA` bank 1 `#ff1868`, `uGlowB` bank 2 `#6602ff`, `uGlowC` fill `#6c06ff` (hue only), `uBgColor` `#030106` |
| `electricvignette` | Electric Vignette | Saturated electric blue banked against the edges, dark core | Tech, cool, framed layouts | `uTint`, `uGlowA` glow `#3302ff` (hue only), `uBgColor` `#03010b` |
| `spectrumdrift` | Spectrum Drift | The Ember Pool footlights slowly cycling amber → rose → violet → blue | Ambient loops, music | `uTint`, `uGlowA…uGlowD` the four stops in order (`#ff5205`, `#ff1071`, `#6d05ff`, `#3300ff`), `uBgColor` `#020204` |
| `emberfacet` | Ember Facet | A huge glowing solid on a dark violet field, its rim burning through a thermal ramp (violet → magenta → gold → white) with chromatic dispersion fringes; dark heat bands sweep across its faces | Bold tech / launch title, dark | `uShape` (select: 0 Facet, 1 Circle, 2 Square, 3 Triangle, 4 Hexagon, 5 Star, 6 Capsule, 7 Blob), thermal ramp `uC0…uC5` cold → core, backlight `uBgA` / `uBgB`, `uInner`, `uOuter`, `uContour` (0–1 glows), `uScale` 0.3–3, `uSpread` 0–1 dispersion, `uSpeed` 0–4 |
| `silkdrift` | Silk Drift | Draped satin folds sweeping diagonally in a slow breeze, threads glinting in the sheen, frame edges smeared by a rainbow-fringed radial zoom blur | Premium, fashion, clean product backdrop (light or dark by look) | `uCloth`, `uGlint`; `uFoldDir` 108–288, `uFoldWidth`, `uFoldDepth`, `uBreeze`, `uGloss`, `uSheenAmt`, `uBloomAmt`, `uWeave`, `uFill` (0–1), `uFiber` 100–190, `uLight` 136–316, `uZoom` 0–100 blur, `uFocus` 0–1, `uDisp` −1–1, `uSpeed` 0–4 |
| `eclipseprism` | Eclipse Prism | Neon light racing round the edge of a huge slowly tumbling solid on near-black, with a faint light leak | Sci-fi, music, framed title on dark | `uShape` (select: 0 Diamond, 1 Circle, 2 Square, 3 Triangle, 4 Hexagon, 5 Star), `uBg`, edge light `uEdgeA…uEdgeC`, leak `uLeakHot` / `uLeakMid` / `uLeakFringe`, `uScale`, `uThickness`, `uSoftness`, `uGlow`, `uBloom`, `uSmoke`, `uSpotSize`, `uSpeed`, `uTumble`, `uTumbleAmt`, `uLeak` 0–0.3, `uLeakSpread`, `uCineon` 0–1 tone mapping |
| `glassreeds` | Glass Reeds | Ribbed glass over a soft swirl; slow swipes of colour bloom and smear through the drifting flutes, then fade to haze | Editorial, calm, white or black glass | `uBg`, `uBg2`, swipe colours `uBase`, `uUp`, `uDown`, `uLeft`, `uRight` (by swipe direction), `uHighlight` + `uHighlightAmt`, flutes `uAngle` 0–180, `uFreq`, `uRefr`, swipes `uRadius`, `uStrokeX`, `uStrokeY`, `uStrokeDir`, `uSpread`, `uBackRate`, `uVariation` (seed), `uGrain` |
| `staticfringe` | Static Fringe | A black field with a fine grid of twinkling star-dots that only shows along the edges, rows drifting sideways, faint colour split | Very subtle, minimal, text-safe | `uBg`, `uDot`; `uDensity`, `uDotSize`, `uTwinkle`, `uDrift` −2–2, `uDispersion`, `uEdge` (how far in), `uOffset` −0.35–0.35 (band position), `uAngle` 0–90 (0 sides, 90 top/bottom), `uSpread` |
| `ripplefold` | Ripple Fold | A three-colour radial gradient folded into soft bands by ripples swelling out from an edge or corner | Warm/cool ambient, title backdrop | `uColorA…uColorC`, `uOriginX` / `uOriginY` 0–1 (ripple source, 0,0 = top-left), `uSize`, `uStretch`, `uDensity` 2–30, `uSoftness`, `uWarp` |
| `nightaurora` | Night Aurora | Soft pools of light pour through a three-colour mesh, sliding and pinching like slow liquid | SaaS hero, ambient | `uColorA` shadow, `uColorB` middle, `uColorC` highlight, `uWarp` 0–0.6, `uSwirl` −1–1, `uDrift`, `uSmooth` 0–5, `uVariation` |
| `pixelbeams` | Dot Spires | Sparse bayer-dither dots gather into drifting towers on a flat field, cut into sliding columns by a square wave | Retro / print texture, subtle | `uColorA` field, `uColorB` dots, `uPixel` 2–20 (cell size, scales with the frame), `uThreshold`, `uDensity`, `uContrast`, `uSpeed`, `uWaveFreq`, `uWaveStrength`, `uWaveAngle` 180–360 |
| `petalgrid` | Petal Grid | Rounded tiles over a drifting two-colour swirl; a diagonal sine band rounds the tile corners as it sweeps | Playful, bold, pop | `uBg` (gap colour), `uColorA`, `uColorB`, `uScale` 4–48 tiles, `uGap`, `uSpeed`, `uDetail`, `uAmp`, `uAngle`, `uThick` |
| `amberblinds` | Amber Blinds | A deep swirl sliced into diagonal bars, a soft sun patch glowing through them, fine film grain | Warm/cool cinematic, light through blinds | `uDeep`, `uSky`, sun `uSun` / `uAmber` / `uGleam`, `uBalance` 0–100, `uFlow`, `uBars`, `uShift`, `uDrift`, `uAngle`, `uSunX` / `uSunY` / `uSunSize`, `uGlow` 0–10, `uGrain` |
| `icehalo` | Ice Halo | Frosted concentric rings each turning at its own pace around a glow rising from the bottom edge | Clean, light, calm | `uColorA` highlight, `uColorB` shadow, `uGlow`, `uBlend` 0–100, `uDetail`, `uSwirlSpeed`, `uIntensity` 0–100, `uRings` 2–30, `uSmooth`, `uSpinSpeed`, `uSpeedRand`, `uCenterY` 0–1.5, `uGlowRadius`, `uGlowSoft`, `uGrain` 0–3 |
| `windowhaze` | Window Haze | Blurred sunlight dapples slanting through a pale room, with soft chromatic fringes | Soft lifestyle / product backdrop | `uBg`, `uShadow`, `uLight`, `uScale`, `uContrast`, `uBalance` −1–1, `uSpeed`, `uBlobX` / `uBlobY` / `uBlobSize` (light patch), `uDeform`, `uSoft`, `uBlur` 0–600, `uAngle` 0–135, `uFringe` |

The vignette / footlight family (`blueplanet` through `spectrumdrift`) is the dark set — most of the frame stays near-black, so it is the safest choice behind white text. `silk`, `waves`, `plasma` and `mesh` are fully lit and want dark or outlined text. Of the rest, `staticfringe`, `eclipseprism` and `emberfacet` (default look) are dark; `silkdrift`, `glassreeds`, `icehalo` and `windowhaze` are light in their default look; the others are mid-tone and fully lit.

**Select params.** A param marked *select* takes one of the listed option numbers (`"uShape": 5` = Star).

**Looks** (`shaderLook`). Every preset has named looks — curated colour sets (and, rarely, a size or amount) for the same shader. Set `shaderLook` to a look id to use it; the render resolves the preset defaults, then the look, then any `shaderParams` on top, so a look plus one tweaked colour is `"shaderId": "silkdrift", "shaderLook": "graphite", "shaderParams": { "uGlint": "#ffe9c4" }`. Look ids are per preset (several presets have a `graphite`). The first id is the default look (same as no `shaderLook`); an unknown id falls back to the defaults.

| `shaderId` | `shaderLook` ids (first = default) |
|---|---|
| `silk` | `dawn`, `sorbet`, `graphite`, `lagoon`, `sunset`, `sage` |
| `glowblobs` | `neon`, `ocean`, `sunset`, `aurora`, `champagne`, `silver` |
| `waves` | `coral`, `lagoon`, `dusk`, `sage`, `graphite`, `amber` |
| `plasma` | `prism`, `lagoon`, `sunset`, `chrome`, `sorbet`, `ultraviolet` |
| `mesh` | `pop`, `peach`, `ocean`, `sunset`, `forest`, `graphite` |
| `fire` | `campfire`, `gas`, `copper`, `arcane`, `ember`, `solar` |
| `spacetravel` | `warp`, `midnight`, `nebula`, `gold`, `lagoon`, `ember` |
| `glitters` | `stardust`, `gilded`, `rose`, `ice`, `emerald`, `amethyst` |
| `blueplanet` | `earth`, `mars`, `eclipse`, `verdant`, `violet`, `lunar` |
| `auroraridge` | `lilac`, `arctic`, `borealis`, `dusk`, `mist`, `gold` |
| `emberpool` | `ember`, `lagoon`, `sunset`, `ultraviolet`, `aurora`, `silver` |
| `neonvignette` | `orchid`, `lagoon`, `sunset`, `cyber`, `emerald`, `silver` |
| `electricvignette` | `cobalt`, `ultraviolet`, `crimson`, `emerald`, `teal`, `silver` |
| `spectrumdrift` | `dusk`, `ocean`, `aurora`, `inferno`, `candy`, `silver` |
| `emberfacet` | `ember`, `glacier`, `acid`, `silver`, `rose`, `magma` |
| `silkdrift` | `pearl`, `graphite`, `champagne`, `rose`, `sage`, `navy`, `oxblood` |
| `eclipseprism` | `prism`, `corona`, `hexa` |
| `glassreeds` | `lilac`, `cobalt`, `neon` |
| `staticfringe` | `grey`, `gold`, `mint`, `violet`, `night`, `paper` |
| `ripplefold` | `tide`, `honey`, `peony` |
| `nightaurora` | `aurora`, `peach`, `reef`, `silver`, `plum`, `moss` |
| `pixelbeams` | `mauve`, `ink`, `amber`, `tide`, `coral`, `poppy`, `shade` |
| `petalgrid` | `petal`, `mint`, `coral`, `cobalt`, `graphite`, `sunset` |
| `amberblinds` | `cobalt`, `coral`, `lagoon`, `graphite`, `rose`, `mint` |
| `icehalo` | `ice`, `dusk`, `sage`, `sand`, `steel`, `midnight` |
| `windowhaze` | `haze`, `golden`, `morning`, `dusk`, `linen`, `charcoal` |

**Shader preset params** (`shaderParams`). Each preset declares tweakable uniforms — **every colour a preset draws is one of them, background included** (`uBgColor` on every preset with a visible background; additive under the light on `fire` / `spacetravel` / `glitters`); store plain values keyed by uniform name — colours as `"#rrggbb"` hex strings, numbers as numbers. Omitted keys use the preset defaults, and every default reproduces the preset's original look (to within 1/255). The `uTint`-style tints (`uTint`, `uFlameTint`, `uStarColor`, `uGlitterColor`, `uSparkColor`) read pure black `#000000` as unset (white) — use a near-black like `#010101` to darken through them. Where the table says *hue only*, the shader keeps its original HDR brightness multiplier and takes only the hue from the colour, because a `#rrggbb` colour cannot express intensities above 1.

## Custom GLSL shaders (project OR shape background)

Custom shader backgrounds are **GLSL**, Shadertoy-shaped, and they are rasterised in their own WebGL context and handed to the compositor as a canvas — so they render identically on either engine the app is set to (`GET /api/video-editor/engine`), and they are the one place custom shading is not tied to it. `iTime` is driven by the **timeline** (not wall-clock), so output is deterministic and identical in preview and export. Send them with `shaderId: "custom"`.

- **Entry point:** `void mainImage(out vec4 fragColor, in vec2 fragCoord)`. Code that defines its own `main()` is used almost as-is instead.
- **In scope:** the Shadertoy uniforms — `iResolution` (vec3; `.xy` is the shader buffer size, which `shaderScale` sets and which is capped at **1280 px on its long side for a shape's background** and 2048 for the project background: a full-frame 1920×1080 shape renders at 1280×720, and a small shape's buffer follows the preview's raster density, so preview and export can differ — compute in `fragCoord / iResolution.xy`, never in composition pixels), `iTime` (seconds: on a shape, from that layer's start; on the project background, the timeline's), `iTimeDelta`, `iFrameRate`, `iFrame`, `iMouse` (zero), `iDate` — plus any uniform the shader declares itself, fed from `shaderParams` (see below).
- `fragCoord` arrives already scaled around the frame centre by `shaderZoom`, so a custom shader honours Scale without doing anything.
- **NOT available:** textures / image inputs (`iChannel0..3`), multi-buffer passes.
- Declaring a name the prelude also declares is safe — the duplicate is dropped from the prelude, which is what lets a pasted Shadertoy shader compile unchanged.
- Output **opaque** colours for a background (alpha `1.0`); alpha is respected if you want translucency.
- A shader that fails to compile falls back to the base `solidColor` — always set a sensible one alongside `shaderCode`.

Minimal example:

```glsl
uniform vec3 uColorA;
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  vec3 col = mix(uColorA, vec3(uv, 0.5 + 0.5 * sin(iTime)), uv.y);
  fragColor = vec4(col, 1.0);
}
```

`shaderSpeed` multiplies the time fed to `iTime` (`0` freezes it, `2` runs twice as fast; up to 30). `shaderScale` controls the shader render buffer: `1` Full, `0.5` Half, `0.25` Quarter, `0.125` Eighth. Reduced detail is softer but keeps pixel-measured dots, lines and sparkles from shrinking away on a large/4K composition; it is part of the saved background config so preview and export use the same buffer scale. `shaderZoom` (0.25–4, editor: **Scale**) is different: it scales the *coordinates* fed to the shader (`fragCoord`) around the frame centre at full sharpness, so `2` doubles the size of the pattern's features. A param in `shaderParams` is fed to the uniform of the same name that the shader code declares (`"#rrggbb"` strings become `vec3`, numbers become `float`), so a shader's controls are whatever uniforms it declares.
