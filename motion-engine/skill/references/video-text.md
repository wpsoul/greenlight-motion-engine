> **GreenLight Motion Engine:** this is the GreenLight Dash Video Editor's project format, which the engine reads as is.
> Ignore the `/api/...` routes and the app UI described here: in the engine you edit `project.json` (or `apply`) and run
> `npx greenlight-motion build`; what `GET /api/video-editor/capabilities` returns there is `npx greenlight-motion schema <topic>`
> here. `frontend/src/…` paths are files of the engine's public source repository. MotionFast templates (`mediaType: "motion"`)
> stay in GreenLight Dash.

# GreenLight Dash — Text and animated captions

> Read [video-projects.md](video-projects.md) for the shared project, clip, channel, timing and versioned-write contracts. Load only the sections needed for the task.

## Contents

- [Text caption layers](#text-caption-layers)
- [How a text layer is structured](#how-a-text-layer-is-structured)
- [Text item fields (defaults the app fills in)](#text-item-fields-defaults-the-app-fills-in): [caption bar look](#caption-bar-look), [caption-bar reveal](#caption-bar-reveal), [Grow Shape](#grow-shape), [shadow](#shadow), [case, decoration and clip mask](#case-decoration-and-clip-mask), [fill style and outline](#fill-style-and-outline), [voice-synced captions](#voice-synced-captions), [Text Randomizer fields](#text-randomizer-fields)
- [3D Text — real extruded letters (`text3d`)](#3d-text--real-extruded-letters-text3d)
- [Dynamic text placeholders (counter, timer, word cycle, scramble, variables, markers, timecode)](#dynamic-text-placeholders)
- [Advanced Animations — effects over a moving range of characters, words or lines](#advanced-animations--effects-over-a-moving-range-of-characters-words-or-lines)
- [Worked example — add a bottom caption to an existing project](#worked-example--add-a-bottom-caption-to-an-existing-project)

## Text caption layers

Use this to add **animated text captions** — e.g. a subtitle that sits at the bottom of a video and reveals word-by-word (or letter-by-letter) with a fade/rise/blur. The motion is **Advanced Animations** (`textAnimators`, its own section below). There is no `/from-clips`-style helper for text; build the text layer by hand into the project's `data` and `PUT` it back.

> Render captions with **`POST /api/moodboards/{board_id}/video-projects/{project_id}/render-onserver`** (the full headless render bakes text, animations and voice in). The fast `POST …/render` composites only single-channel `video`/`image` timelines and drops text layers. See rendering.md (GreenLight Dash only).

### How a text layer is structured

A text layer is two things added to the editor `data`:

1.  A **clip** of `mediaType: "text"` (no media URL — it carries the styling-agnostic identity + default duration):
    ```json
    { "id": "<clipId>", "source": "LOCAL", "mediaType": "text", "url": "", "proxyUrl": null, "name": "Caption 1", "duration": 5 }
    ```
2.  A **timeline item** that references that `clipId` and carries the text content, font styling, on-screen position, and its `textAnimators`. Put it on **its own channel** so it overlays the video instead of playing after it.

**Channel order = z-order.** Channels composite in array order; the **last** channel in `channels` renders on top. So the video channel comes first, the caption's text channel comes **after** it.

**Timing.** Give the caption channel `"unsnapped": true` and set the item's `freeStart` (timeline seconds where the caption appears). The on-screen duration is `trimEnd - trimStart` (the text clip's `duration` is its natural length: set it at least as long as the caption shows, with `trimEnd` ≤ it). Example: `freeStart: 1, trimStart: 0, trimEnd: 3` → caption visible from 1s to 4s. An animator's **in** plays at the start of that window, its **out** at the end.

### Text item fields (defaults the app fills in)

Any field you omit is filled with the default below, so a caption item only needs `id`, `clipId`, the text/style fields you want to change, the position, the timing, and the animation block.

| Field | Default | Notes |
| --- | --- | --- |
| `textContent` | `"Type your text"` | The caption string. `\n` makes hard line breaks; long lines auto-wrap at 86% of frame width. |
| `textColor` | `"#ffffff"` | Any CSS color. |
| `textFontSizeUnit` | `"px"` | `"px"` uses `textFontSize`; `"pct"` uses `textFontSizePct`. |
| `textFontSize` | `96` | Composition pixels (8–1000), used only in `"px"` mode. 96 is title-size at 1080p; captions are commonly 52–72px. A render at another size **with the project's aspect ratio** (720p / 4K of a 1080p project) scales it with the rest of the frame. Only a render at a **different** aspect ratio, which reflows the composition to the new frame, keeps the absolute px (see Output size in rendering.md (GreenLight Dash only)). |
| `textFontSizePct` | `8.9` | Font size as % of the **composition height** (0.5–100), used only in `"pct"` mode: `5.9` equals about 64px at 1080p. Prefer it for API-authored projects that may be rendered at a different aspect ratio: it follows the reflowed frame there, where px does not. Same-aspect renders scale px and pct alike. |
| `textFontFamily` | `"'Helvetica Neue', Helvetica, Arial, sans-serif"` | CSS font stack. |
| `textFontWeight` | `400` | 100–900. Captions read better at 700–800. |
| `textFontStyle` | `"normal"` | `normal` \| `italic`. Slants the whole layer; fonts without a true italic face get the browser's synthesized oblique. |
| `textLineHeight` | `1.15` | 0.7–3. |
| `textLetterSpacing` | `0` | px (−20–80). |
| `textAlign` | `"center"` | `left` \| `center` \| `right`. |
| `textWidthUnit` | `"pct"` | `"pct"` uses `textWidthPct`; `"px"` uses `textWidthPx`. |
| `textWidthPct` | `86` | Text box width as % of the **composition width** (5–100). The box is the wrap width and the left/right-align margin. |
| `textWidthPx` | `null` | Text box width in composition pixels (40–20000), used only in `"px"` mode. |
| `textNoWrap` | `false` | `true` = white-space nowrap: never auto-wrap, only explicit `\n` line breaks start a new line. The box width is ignored. Overflowing text is NOT clipped — the layer's texture grows to the content (up to 4× the composition width), so a zoom-out or a camera/pan move can travel across a long single line. |
| `textWrapAnywhere` | `false` | `true` = a line may break between any two characters (mid-word) to fit the box. Ignored with `textNoWrap`. |
| `panX` | `0` | **Horizontal position**, % of the frame WIDTH from center (±50 = the frame edge; no limit, beyond that is off-frame). + = right. |
| `panY` | `0` | **Vertical position**, % of the frame HEIGHT from center (±50 = the frame edge; no limit). **+ = down**, − = up. Bottom caption ≈ **`panY: 35`** (≈ `38` sits lower). |

#### Caption bar look

A caption-style bar behind each text line. All lengths are composition px.

| Field | Default | Notes |
| --- | --- | --- |
| `textBgEnabled` | `false` | Draws the bar's fill. |
| `textBgColor` | `"rgba(0,0,0,0.6)"` | Any CSS colour. |
| `textBgPadding` | `16` | px (0–200): the spacing around the text on both axes. |
| `textBgPaddingX` / `textBgPaddingY` | `null` | px (0–200): the horizontal and vertical spacing on their own. `null` or omitted falls back to `textBgPadding`. |
| `textBgRadius` | `null` | px (0–200): the corner radius of fill and border. `null` or omitted = automatic: the padding, capped at 40 % of the font size and 40 px. |
| `textBorderEnabled` | `false` | Strokes a border on the bar. It is set apart from the fill, so a bar can be outline-only (`textBorderEnabled` without `textBgEnabled`). The stroke sits inside the bar's bounds, so its width never grows the bar. |
| `textBorderColor` | `"#ffffff"` | Any CSS colour, rgba allowed. |
| `textBorderWidth` | `2` | px (0.5–40). |
| `textBorderStyle` | `"solid"` | `solid` \| `dashed` \| `dotted`. |

#### Caption-bar reveal

Animate the bar (fill or border-only) in and out, so it does not pop in fully drawn while the words are still
animating. In plays over the item's first seconds, Out over its last.

| Field | Default | Notes |
| --- | --- | --- |
| `textBgInType` / `textBgOutType` | `"none"` | `none` \| `fade` \| `mask-right` \| `mask-left` \| `mask-down` \| `mask-up` \| `center-h` \| `center-v`. A mask name is the direction the motion travels, for In and Out alike: In `mask-right` sweeps the bar on left→right and Out `mask-right` sweeps it away left→right, so the same value both ways reads as one continuous pass. `center-*` grow or shrink each bar about its middle. |
| `textBgInStyle` / `textBgOutStyle` | `"wipe"` | `wipe`: the finished bar is clipped by a rectangle, so the leading edge is flat. `slide`: the fill slides behind a mask fixed at the bar's final shape (`mask-*` only). `grow` ([Grow Shape](#grow-shape)): the bar's own rounded shape scales from the anchored edge and keeps its corner radius; pick it for pill-shaped bars. `center-*` take `wipe` or `grow`. |
| `textBgInDuration` / `textBgOutDuration` | `0.5` / `0.4` | s (0.05–4). |
| `textBgInDelay` | `0` | s (0–4): keeps the bar hidden this long before the In starts. Use it when the bar should land after the words have begun animating. There is no Out delay. |
| `textBgInEasing` / `textBgOutEasing` | `"Ease Out"` / `"Ease In"` | An easing display value, the same values as `transitionInEasing` (`"Expo Out"`, `"Back Out"`…). |

#### Grow Shape

With style `grow` the bar extends from a **seed** at the anchored edge, so the fill really starts at about zero
width. Nothing scales about the moving box centre, so the shape never drifts. Out mirrors In: the bar retracts to the
seed, then the seed goes. These fields are ignored unless the slot's style is `grow`.

| Field | Default | Notes |
| --- | --- | --- |
| `textBgInGrowStart` / `textBgOutGrowStart` | `0` | px (0–600): the seed's size. At 0 the seed is the pill's diameter (a circle) when the bar has a radius, otherwise a hairline caret. |
| `textBgInGrowAppear` / `textBgOutGrowAppear` | `"none"` | How the seed appears. `none`: it is there from the first frame and extends. `fade`: it fades in while extending. `scale-in`: it zooms from a dot at the start point (to a caret line, or to a circle with a radius) and only then extends, so the In takes the appear duration plus the duration. `scale-down`: it settles from 150 % about the start point while fading in. |
| `textBgInGrowAppearDuration` / `textBgOutGrowAppearDuration` | `0.4` | s (0.05–4). |
| `textBgInGrowAppearEasing` / `textBgOutGrowAppearEasing` | `"Ease Out"` / `"Ease In"` | Easing display values. |

#### Shadow

Set these only when the user asks for a text shadow: a shadow under type reads as a stock default
([video-design.md](video-design.md#hierarchy)).

| Field | Default | Notes |
| --- | --- | --- |
| `textShadowX` / `textShadowY` | `0` | px (−200–200): the offset. |
| `textShadowBlur` | `0` | px (0–200). The shadow is off while the offset and the blur are all 0. |
| `textShadowColor` | `"rgba(0,0,0,0.75)"` | Any CSS colour. |
| `textShadowSpread` | `0` | px (0–50): thickens the shadow before the blur. |

#### Case, decoration and clip mask

| Field | Default | Notes |
| --- | --- | --- |
| `textLetterCase` | `"none"` | `none` \| `uppercase` \| `lowercase` \| `capitalize`. Re-cases the drawn glyphs without touching `textContent`, so a caption can shout while the stored text does not. |
| `textDecoration` | `"none"` | `none` \| `underline` \| `line-through` \| `overline`. |
| `textClipMask` | `false` | `true` turns the layer into a clipping mask, so footage below plays inside the letters. See the **Clipping masks** paragraph in [video-shapes.md](video-shapes.md#shape-layers-mediatype-shape). |

#### Fill style and outline

`textFillMode` is `"fill"` (default, solid glyphs), `"outline"` (hollow glyphs — the glyph boundary only) or `"both"`. `textOutlineWidth` is the stroke width in px on the text canvas (0–60, default 2; outline modes never go below a 0.5px hairline). `textOutlineColor` is optional — **omit it and the outline uses `textColor`**, so switching mode never silently changes the layer's colour; set it for a contrasting rim in `"both"` mode. Gradients work on the outline exactly as they do on the fill.

Use `textFillMode: "outline"` when putting **Running Glow** on type ([effects.md](video-effects.md#running-glow-entry)): the glow draws on the glyph boundary, and a filled glyph swamps it, whereas a hollow glyph is nothing but boundary. A very thin outline gives the effect little to grab — 3px+ at title sizes, or raise `glowRadius`.

#### Voice-synced captions

Caption items produced by the AI Captions, per-take Captions and AI Shorts flows carry `textWordTimings` — an array with **exactly one `{ "startMs": int, "endMs": int }` entry per whitespace word of `textContent`**, in item-source-local milliseconds (0 = the item's untrimmed start). An animator with `range.drive: "voice"` gives every word (or letter, or line) its turn when it is spoken — see **Drive by Time / Voice** under Advanced Animations. When `textWordTimings` is missing or its length no longer matches the word count of `textContent` (the caption text was edited), a voice animator runs as `time`; the timings stay stored, so restoring the text restores the sync. Attach your own `textWordTimings` (item-local ms, exactly one entry per whitespace word) to any caption item to get the same behaviour.

**Voice link (`textVoiceSource`).** A text layer can name the audio / video / voice layer whose speech times its words: `"textVoiceSource": { "itemId": "<that timeline item's id>", "clipId": "<its clip id>" }` (the app also stores `text`, `at`, `srcAt`, `matched`, `total` — what the last sync saw). A voice sync in the editor derives `textWordTimings` from it: the layer's words are matched against the source's transcript (`item.aiData.transcribe.words`, else `clip.transcript.words`, seconds) where both layers sit on the timeline (trim and speed curve included), loosely enough that a corrected spelling, an inserted or a dropped word still lands; unmatched words are placed between their matched neighbours. A sync runs again when asked, after the text is edited or either layer moves, for one layer or for every layer on the same voice; it can also move a layer whose words are spoken elsewhere onto them, and give every other text layer of the same track the same voice. Captions made by AI Captions and Transcribe are linked when created. When you write a caption yourself, either compute `textWordTimings` directly, or set `textVoiceSource` (`itemId` + `clipId`) and ask the user to run the voice sync in the editor — the link alone does not re-time anything until a sync runs.

#### Text Randomizer fields

The `textRandom*` fields give each word/letter/line its own size, colour, font weight and italic — a deterministic, seeded "ransom note / editorial mix" look. It works on static text and composes with Advanced Animations: units are styled first, the animators then run on the styled result. The distribution value drives size, weight **and** colour eligibility together (the top `textRandomCoverage` % of units get a colour), so with `dist: "nth"` the accented units are the same across all properties.

| Field | Default | Notes |
| --- | --- | --- |
| `textRandomEnabled` | `false` | Turns the Randomizer on. Size, colour and weight then vary unless their own `…Enabled` is set `false`. |
| `textRandomScope` | `"words"` | `words` \| `lines` \| `symbols`: which units get their own style. |
| `textRandomDist` | `"uniform"` | `uniform` \| `gaussian` \| `nth` \| `wave`: how the variation is spread across units. `nth` accents every `textRandomNth`-th unit; `wave` rolls a sine across the text. |
| `textRandomNth` | `3` | 2–12, `nth` only. |
| `textRandomSeed` | `7` | 0–99999: the same seed gives the same look; change it to reshuffle. |
| `textRandomSizeEnabled` | `true` | Varies the size between `textRandomSizeMin` and `textRandomSizeMax`. |
| `textRandomSizeMin` / `textRandomSizeMax` | `80` / `145` | % of the base font size (20–300). |
| `textRandomColorEnabled` | `true` | Gives a share of the units a colour from `textRandomColors`. |
| `textRandomColors` | `["#33efab"]` | Up to 12 hex or rgba strings. |
| `textRandomCoverage` | `35` | 0–100 %: the share of units that get a colour; the rest keep `textColor`. |
| `textRandomWeightEnabled` | `true` | Each unit draws a weight from `textRandomWeights`. |
| `textRandomWeights` | `[300, 700]` | Up to 9 weights from 100–900. |
| `textRandomItalicEnabled` | `false` | Sets units in italic. |
| `textRandomItalicMode` | `"mix"` | `mix` (a share of the units) \| `all`. |
| `textRandomItalicShare` | `30` | 0–100 %, `mix` only. |

Ready-to-paste example (three-colour ransom-note letters, the look of [Classic Ransom Note](video-text-presets.md#classic-ransom-note)):

```json
{
  "textRandomEnabled": true, "textRandomScope": "symbols", "textRandomDist": "uniform", "textRandomSeed": 33,
  "textRandomSizeEnabled": true, "textRandomSizeMin": 75, "textRandomSizeMax": 165,
  "textRandomColorEnabled": true, "textRandomColors": ["#ffd166", "#ff6b81", "#7aa2ff"], "textRandomCoverage": 60,
  "textRandomWeightEnabled": true, "textRandomWeights": [400, 700, 900],
  "textRandomItalicEnabled": true, "textRandomItalicMode": "mix", "textRandomItalicShare": 30
}
```

### 3D Text — real extruded letters (`text3d`)

A text layer can draw every letter as a real 3D solid: depth, rounded (bevelled) edges, a finish, light and
reflections, filmed by the project camera like a 3D model. Everything else stays the text layer's own — font,
size, wrapping, colours and the randomizer, Advanced Animations (Text Animators), Text on Path, keyframes and the
layer transform. **Rotate 3D in a Text Animator turns the letters for real**, showing their sides.

```json
"text3d": {
  "enabled": true,
  "depth": 30,          // extrusion, % of the font size (0–200)
  "bevel": 18,          // roundness: bevel size, % of the font size (0–40; capped per glyph by its stroke)
  "bevelSegments": 5,   // smoothness of the rounded edge (1–10)
  "faceColor": null,    // "#rrggbb" for every letter's face; null = the letter's own colour
  "sideColor": null,    // "#rrggbb" for the sides; null = the face colour darkened by sideShade
  "sideShade": 35,      // % darker for the derived side colour
  "palette": ["#e8392f", "#2f6fe8", "#f5c518", "#2fb04a"], // optional: colours cycled per letter (toy look)
  "material": "plastic",// plastic | matte | metal | glass
  "light": "studio",    // studio | soft | dramatic — only without a 3D Rig in the project
  "envIntensity": 1     // reflections strength (0–3), only without a Rig
}
```

- **Lighting.** With a Scene Rig (3D Rig layer) its lights and environment light the letters. With
  `renderer: "classic"` they also cast and receive the Rig's shadows; in a 3D Scene (any other Rig) the world draws
  the backdrop and the models, and the letters cast no shadow on them. Without a Rig, `light` picks a studio set and
  `envIntensity` the reflections.
- **Fonts.** Each letter is traced from the font the layer really draws with, so Google, uploaded and system fonts
  and any weight work. The face is the 2D glyph's exact outline; the bevel swells the sides outward.
- **Not in 3D:** the caption bar, outline stroke, text shadow and glow, blur and decorations are 2D paint and are not
  drawn on 3D letters. A Text Animator's opacity and colour apply; its blur, glow, shadow and stroke do not.
- **Cost:** a glyph's geometry is built once per font, character, depth and bevel and shared; each frame poses the
  letters and renders one 3D pass. `depth`, `bevel` and `bevelSegments` are not keyframable (they rebuild geometry).

### Dynamic text placeholders

`{{{TYPE:args}}}` tokens inside `textContent` make parts of an ordinary text layer (`mediaType: "text"`) dynamic while the rest stays typed text. Font, colour/gradient, outline, shadow, background bar, randomizer, text on path and Advanced Animations all apply. A token that doesn't parse — or a VAR with no value — stays visible as typed. Layer names and the timeline show a resolved value instead of the token.

| Token | What it does |
|---|---|
| `{{{COUNTER:0-100}}}` | A number animating between two values. Format follows the typed range: `1,000-25,000` separators · `0.0-99.9` decimals (max 4) · `00-59` zero-padded · `100-0` counts down · `-50..50` negatives (`..`, `to`, `–` also separate) · `250` alone = 0 → 250. |
| `{{{TIMER:05:00-00:00}}}` | A clock: `ss`, `mm:ss` or `h:mm:ss`, optional `.s` decimals. One value alone (`05:00`) counts down to zero. Runs in real time by default; same styles as COUNTER. |
| `{{{CYCLE:fast\|simple\|yours}}}` | Words or phrases take turns: each holds `hold` s, then rolls / fades / blurs / **morphs** to the next. Morph: the letters both share travel from their place in one to their place in the next; the others leave and arrive. |
| `{{{SCRAMBLE:Access granted}}}` | Random characters decoding into the text one by one; keeps its final width the whole time. |
| `{{{VAR:product}}}` | A PROJECT variable — `data.textVariables: [{ "name": "product", "value": "GreenLight" }]` at the top level of the project data (names unique ignoring case). Expands to plain text, so it wraps and animates like typed words. |
| `{{{MARKER}}}` / `{{{MARKER:Intro}}}` | The name of the last timeline marker (`data.markers`) the playhead passed; the argument is shown before the first one (and for an unnamed marker). Plain text, like VAR. |
| `{{{TIMECODE}}}` | The timeline time `hh:mm:ss:ff` in equal digit cells. Arguments: `clip` (time since the layer started) and/or a format `hh:mm:ss`, `mm:ss`, `mm:ss:ff`, `ss:ff`, `ss` — e.g. `{{{TIMECODE:clip mm:ss}}}`. |
| `{{{FRAME}}}` / `{{{FRAME:clip}}}` | The frame number (project, or from the layer's start). |

**Each placeholder's own settings go INSIDE its token**, after `;` as `key=value` pairs — write only what differs from the default (the editor writes exactly this, and removes an option set back to its default). Settings therefore travel with the text:

```
Orders {{{COUNTER:0-2,480; style=roll; duration=2.5; easing=expo_out}}} in {{{TIMER:05:00; duration=10}}}
{{{CYCLE:fast|simple|yours; style=fade; hold=0.8; loop=off}}}   {{{SCRAMBLE:Access granted; chars=binary; order=random}}}
```

| Type | Options (defaults) |
|---|---|
| COUNTER | `style` odometer\|roll\|count (odometer) · `start` s (0) · `duration` s (1.8) · `easing` a TransitionEasing key in lowercase, e.g. `cubic_out` (cubic_out) · `width` fixed\|fit (fixed) · `digits` tabular\|natural, Count only (tabular) · `turns` 0–10 (3) · `lands` left\|right\|together (left) · `cascade` 0–90 % (45) · `direction` auto\|up\|down (auto) · `blur` 0–100 % (35) · `kf` a track id |
| TIMER | the same keys; defaults are a real clock: `style` count, `duration` = the timer's own span (05:00 → 300 s), `easing` linear |
| CYCLE | `style` roll\|fade\|blur\|morph (roll) · `start` (0) · `hold` s per state (1.2) · `duration` transition s (0.45; morph = each letter's travel, 0.8) · `easing` (cubic_out; morph expo_in_out) · `width` fit\|fixed (fit) · `direction` up\|down: roll, and a morph's rise/arc (up) · `loop` on\|off (on) · morph only: `match` order\|any (order) · `case` ignore\|keep (ignore) · `stagger` s between letters 0–2 (0.03) · `arc` 0–1 (0) · `leave` mask\|fade\|blur\|scale (fade) · `order` left\|center\|all (left) |
| SCRAMBLE | `start` (0) · `duration` (1.2) · `chars` symbols\|letters\|digits\|binary\|blocks (symbols) · `order` ltr\|rtl\|random (ltr) · `flicker` glyph changes/s (18) |
| TIMECODE / FRAME | no options — `clip` and the format are the token body (`{{{TIMECODE:clip mm:ss}}}`) |

- Styles: `odometer` — each digit column rolls on its own from start digit to end digit, `turns` extra spins on the rightmost column, columns landing in a cascade; `roll` — a mechanical odometer (the last digit spins fastest, carries turn the next column; a timer's seconds-tens wheel has six digits); `count` — the digits just change.
- Timing is seconds on the item's **source** clock (`trimStart` + clip time). `width: fixed` reserves room for the widest value (nothing around it moves); `fit` closes the gap so neighbouring words slide.
- Keyframed progress: `kf=<id>` makes the placeholder follow `propertyKeyframes["ph:<id>"]` (values `"0"`–`"100"`, % of the way from start to end) instead of start/duration/easing — e.g. `{{{COUNTER:0-100; kf=1}}}` with a `ph:1` track. Each placeholder can have its own.
- Unknown or malformed options are ignored (the token still renders). The layer fields `textCounter*` / `textCycle*` / `textScramble*` and the layer-wide `textCounterProgress` track are read for tokens without options; write token options instead.

**Text Morph** (`style=morph`): one text turns into the next. `match=order` pairs letters that keep their order; `any` lets any letter go anywhere (anagrams: `Dash|Hands; match=any; order=center; arc=0.7; leave=scale`). Pairs that differ only in case (`i`↔`I`) crossfade on the way unless `case=keep`. Letters leave in the direction (`up`) and arrive from the other side. `leave`: `mask` slides them out of a line-high mask; `fade` rises 0.4 em and fades; `blur` blurs out; `scale` shrinks away. Each step lasts `duration + stagger × (letters involved − 1)`, then the next state holds `hold` s. A state at rest looks exactly like the typed text; letters travel around the line's alignment (left / centre / right edge).

```
{{{CYCLE:Give it a studio|GIVIT Studio; style=morph; loop=off}}}
Any {{{CYCLE:model|bot|agent; style=morph; leave=mask}}}
```

**Line states** (`textLineStates`): every line of `textContent` is one state of a cycle, no token needed. The first line shows, then turns into the next, and so on. The field takes the CYCLE options as JSON (`easing` = a TransitionEasing key in UPPERCASE, `loop` a boolean). Only `style` is required; omit defaults; `null` / absent = off. Blank lines are skipped. A placeholder inside a line shows its resting value.

```json
{ "textContent": "Connect\nGenerate\nTalk\nPost",
  "textLineStates": { "style": "morph", "hold": 0.9, "leave": "mask", "stagger": 0.026 } }
```

```json
{ "textContent": "Fast\nSimple\nYours", "textLineStates": { "style": "roll", "hold": 1, "loop": false } }
```

The whole cycle is one unit of the text: Text Animators, the randomizer and text on path treat it as one character. 3D Text films the letters; there `mask` and `blur` become fades. A state never wraps onto a second line.

### Advanced Animations — effects over a moving range of characters, words or lines

**Start from a preset recipe** before building animators from scratch: the app's presets are ready JSON, tuned in the app.
- Energetic text (a title, hook, promo or social line, anything punchy, bouncy or kinetic): [video-text-kinetic.md](video-text-kinetic.md) — 22 in-and-out animations (Swing Pop and its family).
- Everything else: [video-text-presets.md](video-text-presets.md) — 54 recipes plus the app's 29 Classic ones. Sweep Reveal (typing under a colour band), Type on Shape (text typed onto a pill, card or bar that grows with it), Depth (words and letters moving in real depth under one camera: Rack Focus, Stand Up, Strata, Spotlight, Ripple), Emphasis (one highlight pass), Loop (neon, rainbow, float, flicker), Characters (decode, binary, glitch), Voice (caption karaoke on `textWordTimings`) and Classic (calm word or letter reveals, highlights, caption bars and randomizer looks, e.g. Fade Up, Rise (Mask), Typewriter, Lower Third).

**Pace:** entrances, exits and passes take ≥ 0.8 s by default; recipes keep their tuned timing. The rule, its formula and exceptions: [video-design.md](video-design.md#text-animation-pace).

`GET /api/video-editor/capabilities` does not list Text Animator effects or presets: this page and the two preset pages are their schema.

The After Effects text-animator model on a text layer (stored as `textAnimators`). `item.textAnimators` is a list of animators; each one **selects** units of the text with a range (plus an optional wiggle) and applies its **effects** to them. Every effect value is what a unit gets at 100 % selection; the unit's selection amount (−1…1) scales it. What moves the selection is the range's `drive`: `range` (default) = Start / End / Offset, animated with `txa:` keyframe tracks or with `flow` for an endless keyframe-free travel; `time` = every unit takes its turn in seconds (a stagger, with In / Out and a highlight clock); `voice` = every unit takes its turn when it is spoken (captions). Renders identically in preview, `/render-onserver` and stills.

`textAnimators` is the only text animation. Never write `textSplit*`, `splitIn*`, `splitOut*`, `textHighlight*` or `textCaret*` fields, or `textRevealProgress` / `textHighlightColor` tracks: the app ignores them. A stored project that carries them is converted into `textAnimators` when the app loads it, so a `GET` of a project the app has not loaded may show them.

```jsonc
"textAnimators": [{
  "aid": "a1", "name": "Animator 1", "enabled": true,
  "range":  { "drive": "range", "basedOn": "chars", "around": "auto", "mask": false,
              "units": "percent", "start": 0, "end": 20, "offset": 0,
              "shape": "smooth", "smooth": 100, "easeHigh": 0, "easeLow": 0, "amount": 100,
              "randomize": false, "seed": 1, "flow": 0, "loop": false,
              // drive "time" / "voice" only:
              "animate": "in", "order": "forward", "delay": 0, "stagger": 0.06, "duration": 0.6,
              "curve": "Ease Out", "hold": 0, "fadeOut": 0, "keepLast": false, "spread": true },
  "wiggle": { "enabled": false, "mode": "intersect", "max": 100, "min": -100, "rate": 2,
              "corr": 0, "tPhase": 0, "sPhase": 0, "seed": 1 },
  "effects": [ { "pid": "p1", "type": "fill", "enabled": true, "color": "#ffd84d", "mix": 100 } ]
}],
"textAnimatorPivotX": 0,          // −100…100 % of the unit's box from its centre (100 = right edge)
"textAnimatorPivotY": 0           // −100…100 % (100 = bottom)
"textAnimatorCamera": "layer",    // who films Position z and Rotate 3D: "unit" (default, omit) | "layer" | "project"
"textAnimatorPerspective": 1300   // "layer" only: the camera's distance in px; omit / 0 = the composition camera's (2166 px at 1080p)
```

Rules the sanitizer enforces (anything else is dropped or clamped on load): `aid`/`pid` match `[A-Za-z0-9_-]{1,24}` and are unique; at most 8 animators and 12 effects per animator; unknown effect `type`s are dropped; every field takes its default when missing. Omit `textAnimators` (or leave it empty) for a layer without animators — the three layer fields are written only alongside a non-empty list. All px values are composition px.

**Range** (`range`):

| Field | Values (default) | Meaning |
|---|---|---|
| `drive` | `range` \| `time` \| `voice` (`range`) | What moves the selection — see **Drive by Time / Voice** below. Under `time`/`voice` the Start…Flow fields are unused. |
| `basedOn` | `chars` \| `charsNoSpace` \| `words` \| `lines` (`chars`) | What one unit is. With `charsNoSpace`/`words`, a space between two selected units is selected with them. |
| `around` | `auto` \| `char` \| `word` \| `line` \| `all` (`auto`) | The unit this animator's transforms turn around; `auto` = its `basedOn`. |
| `mask` | bool (false) | Each unit is cut off at the edge of its own resting box (its `around` unit across; down, its row's ink: the highest letter top to the lowest letter bottom, not the line height), so a move slides it in from behind that edge. A vertical Position under the mask travels at least that box's height, so the units start fully hidden even when Y is smaller (X is left as set); resting outline, text shadow and underline are never cut. |
| `units` | `percent` \| `index` (`percent`) | `start`/`end`/`offset` in % of the unit count, or in units (`start: 2` = the third unit). |
| `start`, `end` | −1000…1000 (0, 100) | The selected span; swapped if reversed; % values clamp to 0–100. |
| `offset` | −1000…1000 (0) | Shifts the whole span — the field to animate for sweeps. |
| `shape` | `square` \| `rampUp` \| `rampDown` \| `triangle` \| `round` \| `smooth` (`square`) | Selection profile across the span. `rampUp` stays fully selected after the span and `rampDown` before it, so moving `offset` across the text builds or clears the effect unit by unit (the classic cascade); the other shapes are 0 outside the span. |
| `smooth` | 0–100 % (100) | `square` only: width of the edge fade in units (100 = one unit, so an edge unit is selected by how much the span covers it). |
| `easeHigh`, `easeLow` | −100…100 % (0) | Non-square shapes: bend the profile near 1 / near 0 (+ lingers, − snaps). |
| `amount` | −100…100 % (100) | Scales the selection; negative pushes every effect the other way. |
| `randomize`, `seed` | bool (false), 0–9999 (1) | Shuffles which unit sits where in the span (deterministic per seed). |
| `flow` | −400…400 (0) | Offset added per second (%/s or units/s) — continuous travel without keyframes. Without `loop`, a span starting at a negative offset flows in and stops at 0; start at 0 to travel off the text. |
| `loop` | bool (false) | The span wraps around the ends (pair with `flow` for an endless pass). Under `time`: the cascade repeats (with `in`/`active`/`stay`, not `out`/`inOut`, nor while voice-synced). |

**Drive by Time / Voice.** Every unit gets its own clock instead of a moving span; no keyframes, and the seconds are anchored to the layer's start (In) and end (Out), so trimming a layer never stretches the motion.

| Field | Values (default) | Meaning |
|---|---|---|
| `animate` | `in` \| `out` \| `inOut` \| `active` \| `stay` (`in`) | `in`: units arrive FROM the effects (amount 1 → 0 over `duration` from the unit's turn). `out`: units leave INTO them; the turns run on the layer clock and the last unit finishes exactly at the layer end (− `delay`). `inOut`: both, same effects. `active`: the effects light each unit in turn (0 → 1 at its turn, back to 0 after `hold`). `stay`: lit from its turn on. |
| `order` | `forward` \| `backward` \| `center` \| `edges` \| `random` (`forward`) | Time: which unit goes first (`random` uses `seed`). |
| `delay` | −60…600 s (0) | In: after the layer starts. Out: before it ends. Voice: after the word is spoken (negative = before). |
| `stagger` | 0…10 s (0.06) | Time: between one unit's turn and the next. |
| `duration` | 0…20 s (0.6) | How long each unit takes (0 = instant). For `active`/`stay` it is the fade-in. |
| `curve` | the app's easing names (`Ease Out`) | Each unit's own easing: `Linear`, `Ease In/Out`, `Smooth`, `Smooth Glide`, `Glide Easing Stop`, `Sine/Expo/Back In/Out/Smooth`, `Cubic In/Out`, `Power`, `Punch`, `Apple Out`, `Bounce Out`, `Elastic`, `Overshoot`, `Smooth Overshoot`, `Impulse`, `Swing`, `Anticipate`, `Natural`, `Slow Down`, `AE In (arrive)`, `AE Smooth`, `AE Out (leave)` (an alias such as `Power2 Smooth` loads as the name it maps to). Back, Bounce, Elastic and the Overshoots land each unit past its rest and settle (transforms follow the overshoot, colours clamp). `Anticipate` is an exit: the unit winds back the other way (to −0.38 of the move at 58 %), then snaps through in the last frames. `Custom` plays `bezier`. |
| `bezier` | `[x1, y1, x2, y2]` or null (null) | The `Custom` curve's handles, the same shape as a keyframe's `bezier` (x 0…1, y −3…4; past 0…1 = overshoot). Write it together with `"curve": "Custom"`: a `Custom` without it plays `Ease Out`, and any named `curve` drops it. |
| `hold` | 0…600 s (0) | `active`: how long a unit stays lit; 0 = until the next unit's turn (voice: until the next word starts). |
| `fadeOut` | 0…20 s (0) | `active`: fade back down after `hold`. |
| `keepLast` | bool (false) | `active`: the last unit stays lit. |
| `spread` | bool (true) | Voice + `chars`/`charsNoSpace`: the letters of a word take their turns across the time the word is spoken (typed at speaking pace); false = the whole word together. |

`voice` reads the item's `textWordTimings` (one `{ startMs, endMs }` per whitespace word, item-source ms — captions made from a transcript carry them). A line's turn spans its first word's start to its last word's end. With no timings, or not one per word (the text was edited), the animator runs as `time` — restoring the text restores the sync. An `out` side always runs on time. Under `time`, unit i starts at `delay + i × stagger`; an `out` cascade ends with the layer.

**Wiggle** (`wiggle`, off unless `enabled`): a smooth random selection between `min` and `max` % that changes `rate` times a second, combined with the range by `mode` (`intersect` = only inside the range, `add`, `subtract`, `min`, `max`, `difference`). `corr` 0–100 % makes units wiggle together; `tPhase`/`sPhase` −360…360° offset it in time / across units; `seed` picks the pattern.

**Effects** (`effects[]`, applied top to bottom; animators apply in list order). Transforms from every animator add up per unit and turn around the layer pivot above:

| `type` | Fields (default) | How the selection applies |
|---|---|---|
| `position` | `x` 0, `y` −80, `z` 0 px | adds value × amount. `z` = depth, + toward the viewer. Under a shared camera (`textAnimatorCamera` `layer` / `project`) the unit really moves in depth: nearer units grow, all converge to one vanishing point, nearer covers farther, a unit at or past the camera is not drawn. With each unit's own camera (default) `z` scales the unit in place by D / (D − z), D = its Rotate 3D `perspective`, else `textAnimatorPerspective`, else the composition camera's distance |
| `scale` | `scale` 160, `x` 100, `y` 100 % | 100 % → value, multiplies |
| `rotation` | `angle` 45° | adds |
| `rotate3d` | `x` 90, `y` 0°, `perspective` 800 px | adds; real perspective. Each unit's own camera (default): a camera `perspective` px in front of the unit (0 = flat); every unit turns like its own card. Under a shared camera `perspective` is ignored and every turn shares that camera's vanishing point. +X tips the top away, +Y the right side |
| `skew` | `skew` 25°, `axis` 0° | adds |
| `tracking` | `amount` 40 px | adds space around the unit; the row reflows and re-aligns |
| `opacity` | `opacity` 0 % | 100 % → value, multiplies |
| `fill` | `color` `#ffd84d`, `mix` 100 % | mixes the unit's colour toward `color` |
| `gradient` | `colors` (2–6 hex), `angle` 0°, `span` `text`\|`unit`, `shift` 0 %, `repeat` false, `mix` 100 % | paints the unit with the gradient (across the whole text or each unit); `shift` slides the colours, `repeat` lets them loop |
| `hue` | `hue` 180°, `saturation` 0, `brightness` 0 % | rotates whatever colour the unit has at that point |
| `stroke` | `color` `#ffffff`, `width` 4 px, `outline` false | outline around the glyphs; `outline: true` fades the fill out |
| `glow` | `color` `#5ef2ff`, `size` 30 px, `strength` 120 % | light around the glyphs (Deep Glow): a hot core and an inverse-square tail reaching about 5 × `size`; units with the same `size` share one glow, at most three sizes per layer |
| `shadow` | `color` `#000000`, `x` 0, `y` 18, `blur` 20 px, `opacity` 70 % | offset shadow; only when the user asks for a text shadow |
| `blur` | `amount` 18 px | defocus |
| `box` | `color` `#33efab`, `behind` `selected`\|`revealed`, `shape` `line`\|`unit`\|`block`, `padX` 12, `padY` 4, `radius` 10 px, `opacity` 100 %, `grow` true, `withText` false | `line`: one bar behind each run of selected units in a row; `unit`: a bar behind each selected unit of `basedOn` (a whole word even when drawn by letters), as bright as its amount; `block`: one shape around all of it. `behind: revealed` = behind what this animator lets through (a typing animator grows its box). `grow` makes a moving span sweep it like a marker. `withText` (`unit` only): each bar is as visible as its unit — every animator's opacity included — so a word that has not appeared yet has no bar |
| `caret` | `style` `bar`\|`underscore`\|`block`, `ownColor` false, `color`, `width` 0 (auto) px, `blink` 1.1/s, `hide` false, `hideAfter` 0 s | a text cursor at this animator's reveal edge (what an Opacity 0 on the same range lets through): on an `in` animator it types with the text; solid while typing, blinking otherwise, gone when an `out` starts or `hideAfter` s after the typing ends |
| `scramble` | `charset` `upper`\|`lower`\|`digits`\|`alnum`\|`symbols`\|`binary`\|`blocks`, `rate` 18/s, `seed` 1 | a unit shows random glyphs with probability = its selection |
| `charOffset` | `offset` 6 | shifts letters/digits by `round(offset × amount)` through the alphabet |

`textAnimatorCamera` / `textAnimatorPerspective` are written only while the camera is shared; `"unit"` and a Perspective of 0 are dropped.

**Depth and one camera.**
- `layer` puts one camera in front of the text plate's centre; it rides the layer, like CSS perspective inside a 3D-transformed element.
- `project` films the letters with the project's Camera layer. A dolly, pan, tilt or the layer's own `rotateX`/`rotateY` gives true parallax between letters at different `z`; with no camera move it equals `layer`.
- 3D Text (`text3d`) letters move in real depth with `z`; the camera field doesn't apply there.
- Track: `txa:<aid>:<pid>.z`.

```json
{ "textAnimators": [{ "aid": "a1", "name": "Fly in", "enabled": true,
    "range": { "drive": "time", "animate": "in", "basedOn": "charsNoSpace", "stagger": 0.06, "duration": 1.4, "curve": "Expo Out" },
    "effects": [{ "pid": "p1", "type": "position", "x": 0, "y": 0, "z": -3200 }, { "pid": "p2", "type": "opacity", "opacity": 0 }] }],
  "textAnimatorCamera": "project" }
```

Colours must be 6-digit `#rrggbb`; `#fff`, `rgba()` or names silently become the effect's default colour. On a text layer used as a clip mask (`textClipMask`), `glow`, `shadow` and `box` are skipped (they would become coverage). `box` is not drawn on text on a path.

**Keyframes.** `propertyKeyframes["txa:<aid>:<chan>"]`, the usual `{ position, value, easing }` keys, value in the field's own units:
- range: `start`, `end`, `offset`, `amount`, `smooth`, `easeHigh`, `easeLow` (under `time`/`voice` only `amount`)
- wiggle: `wig.max`, `wig.min`, `wig.corr`
- effect: `<pid>.<field>` for any numeric effect field except `scramble` `rate`/`seed` and `caret` `width`/`blink`/`hideAfter` (e.g. `txa:a1:p2.y`)

Rates (`flow`, wiggle `rate`) and seeds are not keyframable. A track whose animator or effect no longer exists is dropped on load.

**Speed curves.** A text layer's own animation plays on its **speed-mapped clock**, like a video's frames: with `speedPoints` (or a `speed` track) on the layer, the animators, the times they run on (`time`/`voice` delays and durations, Flow, Wiggle, the caret) and the caption-bar reveal follow the curve. So a `txa:` key's `position` is a % of the clip's **source** length (`trimEnd − trimStart`, its 1× length), not of its timeline length; on a flat curve the two are the same. Its other keyframe tracks (position, scale, opacity, colours) stay on the timeline. The editor draws and edits `txa:` keys where they play.

Worked examples of the mechanisms (spread onto a text item; durations assume a 4 s layer). For a finished look, take the
app's recipe instead: a band sweeping the letters once is [Colour Sweep](video-text-presets.md#colour-sweep), typing under a
colour band is [Ember Type](video-text-presets.md#ember-type) and the other Sweep Reveal recipes, an endless neon pass is
[Neon Flow](video-text-presets.md#neon-flow), a box under each spoken word is [Spoken Box](video-text-presets.md#spoken-box),
letters typed at speaking pace are [Typed as Spoken](video-text-presets.md#typed-as-spoken), and energetic in-and-out
titles are in [video-text-kinetic.md](video-text-kinetic.md).

```jsonc
// Cascade in: letters drop and spin into place left to right (rampUp = everything after the span is still hidden).
"textAnimators": [{ "aid": "a1", "name": "Cascade", "range": { "end": 30, "shape": "rampUp" },
  "effects": [ { "pid": "p1", "type": "position", "x": 0, "y": -140 }, { "pid": "p2", "type": "rotation", "angle": -35 },
               { "pid": "p3", "type": "opacity", "opacity": 0 } ] }],
"propertyKeyframes": { "txa:a1:offset": [ { "position": 0, "value": "-30", "easing": "Smooth" }, { "position": 85, "value": "100", "easing": "Smooth" } ] }

// Fade Up, pace-adjusted (Time; slower than the app's Classic Fade Up): words rise in 0.06 s apart, and leave upward at the end.
"textAnimators": [
  { "aid": "a1", "name": "In", "range": { "drive": "time", "animate": "in", "basedOn": "words", "stagger": 0.06, "duration": 0.8, "curve": "Smooth" },
    "effects": [ { "pid": "p1", "type": "position", "x": 0, "y": 50 }, { "pid": "p2", "type": "opacity", "opacity": 0 } ] },
  { "aid": "a2", "name": "Out", "range": { "drive": "time", "animate": "out", "basedOn": "words", "stagger": 0.06, "duration": 0.7, "curve": "Smooth" },
    "effects": [ { "pid": "p3", "type": "position", "x": 0, "y": -50 }, { "pid": "p4", "type": "opacity", "opacity": 0 } ] }]

// Typewriter with a caret (Time): letters appear 0.05 s apart; the caret blinks once typing ends and hides 1 s later.
"textAnimators": [{ "aid": "a1", "name": "Type", "range": { "drive": "time", "animate": "in", "basedOn": "charsNoSpace", "stagger": 0.05, "duration": 0, "curve": "Linear" },
  "effects": [ { "pid": "p1", "type": "opacity", "opacity": 0 }, { "pid": "p2", "type": "caret", "style": "bar", "hide": true, "hideAfter": 1 } ] }]

// Typewriter by keyframes: Start is how much of the text is typed (a Square span with Smooth 100
// selects each letter by how much of it is not typed yet). Type, pause, delete back to 40 %.
"textAnimators": [{ "aid": "a1", "name": "Type", "range": { "drive": "range", "basedOn": "chars", "start": 0, "end": 100, "shape": "square", "smooth": 100 },
  "effects": [ { "pid": "p1", "type": "opacity", "opacity": 0 }, { "pid": "p2", "type": "caret", "style": "bar" } ] }],
"propertyKeyframes": { "txa:a1:start": [ { "position": 0, "value": "0", "easing": "Linear" }, { "position": 35, "value": "100", "easing": "Linear" },
  { "position": 60, "value": "100", "easing": "Linear" }, { "position": 75, "value": "40", "easing": "Linear" } ] }

// Highlight two words: a marker bar sweeps under characters 9–17 (index units) and turns them dark.
"textContent": "Make the key words pop",
"textAnimators": [{ "aid": "a1", "name": "Highlight", "range": { "units": "index", "start": 9, "end": 9 },
  "effects": [ { "pid": "p1", "type": "box", "color": "#33efab", "padX": 10, "padY": 8, "radius": 12 }, { "pid": "p2", "type": "fill", "color": "#07130e" } ] }],
"propertyKeyframes": { "txa:a1:end": [ { "position": 8, "value": "9", "easing": "Smooth" }, { "position": 40, "value": "18", "easing": "Smooth" } ] }
```

### Worked example — add a bottom caption to an existing project

1.  `GET /api/moodboards/{board_id}/video-projects/{project_id}` → take its `data` (or build a fresh project from clips first).
2.  Append a text clip + a new top channel carrying the caption item, then `PUT` the whole `data` back with the GET response's `version` as `expected_version`. Preserve the existing clips and channels when applying this example. The caption channel goes **last** (renders on top), is `unsnapped`, sits at the bottom (`panY: 35`), and rises in word by word (Fade Up as animators):

```json
PUT /api/moodboards/{board_id}/video-projects/{project_id}
{
  "expected_version": 7,
  "data": {
    "videoSize": { "w": 1920, "h": 1080 },
    "clips": [
      { "id": "vid1", "source": "REMOTE", "mediaType": "video", "url": "/media/admin/{board_id}/clip.mp4", "name": "Clip", "duration": 8 },
      { "id": "cap1", "source": "LOCAL", "mediaType": "text", "url": "", "proxyUrl": null, "name": "Caption 1", "duration": 5 }
    ],
    "channels": [
      { "id": "chV", "name": "Video", "visible": true, "items": [
        { "id": "itV", "clipId": "vid1", "trimStart": 0, "trimEnd": 8 }
      ] },
      { "id": "chT", "name": "Captions", "visible": true, "unsnapped": true, "items": [
        {
          "id": "itT", "clipId": "cap1",
          "freeStart": 1.0, "trimStart": 0, "trimEnd": 3.0,
          "textContent": "This is the caption", "textColor": "#ffffff",
          "textFontSizeUnit": "pct", "textFontSizePct": 5.9,
          "textFontWeight": 800, "textAlign": "center",
          "panX": 0, "panY": 35,
          "textAnimators": [
            { "aid": "a1", "name": "In", "range": { "drive": "time", "animate": "in", "basedOn": "words", "stagger": 0.06, "duration": 0.8, "curve": "Smooth" },
              "effects": [ { "pid": "p1", "type": "position", "x": 0, "y": 50 }, { "pid": "p2", "type": "opacity", "opacity": 0 } ] },
            { "aid": "a2", "name": "Out", "range": { "drive": "time", "animate": "out", "basedOn": "words", "stagger": 0.06, "duration": 0.7, "curve": "Smooth" },
              "effects": [ { "pid": "p3", "type": "position", "x": 0, "y": -50 }, { "pid": "p4", "type": "opacity", "opacity": 0 } ] }
          ]
        }
      ] }
    ],
    "activeChannelId": "chT",
    "selectedTimelineId": null,
    "currentTime": 0
  }
}
```

The app fills every omitted field (transitions, filters, opacity, etc.) with defaults, so the caption item above is complete. For multiple captions, reuse the channel only when their visible windows do **not** overlap. Any lines that must appear together (for example eyebrow + headline + sub-caption) need separate channels, one live item per channel.

3.  To produce the finished file with the caption burned in, `POST /api/moodboards/{board_id}/video-projects/{project_id}/render-onserver` (the full render; see the note at the top). Optionally `.../activate` first so it also opens as the board's active project.

* * *
