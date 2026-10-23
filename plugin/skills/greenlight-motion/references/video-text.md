> **GreenLight Motion Engine:** this is the GreenLight Dash Video Editor's project format, which the engine reads as is.
> Ignore the `/api/...` routes and the app UI described here: in the engine you edit `project.json` and run
> `npx greenlight-motion build`. MotionFast templates (`mediaType: "motion"`) stay in GreenLight Dash.

# GreenLight Dash — Text and animated captions

> Read [video-projects.md](video-projects.md) for the shared project, clip, channel, timing and versioned-write contracts. Load only the sections needed for the task.

## Contents

- [Text caption layers](video-text.md#text-caption-layers)
- [How a text layer is structured](video-text.md#how-a-text-layer-is-structured)
- [Text item fields (defaults from `sanitizeTimelineItem`)](video-text.md#text-item-fields-defaults-from-sanitizetimelineitem)
- [Dynamic text placeholders (counter, timer, word cycle, scramble, variables, markers, timecode)](video-text.md#dynamic-text-placeholders)
- [Advanced Animations — effects over a moving range of characters, words or lines](video-text.md#advanced-animations--effects-over-a-moving-range-of-characters-words-or-lines)
- [Worked example — add a bottom caption to an existing project](video-text.md#worked-example--add-a-bottom-caption-to-an-existing-project)

## Text caption layers

Use this to add **animated text captions** — e.g. a subtitle that sits at the bottom of a video and reveals word-by-word (or letter-by-letter) with a fade/rise/blur. The motion is **Advanced Animations** (`textAnimators`, its own section below). There is no `/from-clips`-style helper for text; build the text layer by hand into the project's `data` and `PUT` it back.

> ⚠️ **To bake text in, render with `/render-onserver` — not `/render`.** The fast `POST .../render` only composites single-channel `video`/`image` timelines and **ignores** text layers, extra channels, keyframes, and text animations. To get a file with the caption burned in, call **`POST /api/moodboards/{board_id}/video-projects/{project_id}/render-onserver`** (full headless render — bakes in text/voice/animations) after adding the caption. Do **not** call `/render` for a project with captions and report success — the text won't be there. (The desktop editor's **Render Video → Render in Background** does the same thing.)

### How a text layer is structured

A text layer is two things added to the editor `data`:

1.  A **clip** of `mediaType: "text"` (no media URL — it carries the styling-agnostic identity + default duration):
    ```json
    { "id": "<clipId>", "source": "LOCAL", "mediaType": "text", "url": "", "proxyUrl": null, "name": "Caption 1", "duration": 5 }
    ```
2.  A **timeline item** that references that `clipId` and carries the text content, font styling, on-screen position, and its `textAnimators`. Put it on **its own channel** so it overlays the video instead of playing after it.

**Channel order = z-order.** Channels composite in array order; the **last** channel in `channels` renders on top. So the video channel comes first, the caption's text channel comes **after** it.

**Timing.** Give the caption channel `"unsnapped": true` and set the item's `freeStart` (timeline seconds where the caption appears). The on-screen duration is `trimEnd - trimStart` (the text clip's natural length is 5s, so `trimEnd` ≤ 5). Example: `freeStart: 1, trimStart: 0, trimEnd: 3` → caption visible from 1s to 4s. An animator's **in** plays at the start of that window, its **out** at the end.

### Text item fields (defaults from `sanitizeTimelineItem`)

Any field you omit is filled with the default below, so a caption item only needs `id`, `clipId`, the text/style fields you want to change, the position, the timing, and the animation block.

| Field | Default | Notes |
| --- | --- | --- |
| `textContent` | `"Type your text"` | The caption string. `\n` makes hard line breaks; long lines auto-wrap at 86% of frame width. |
| `textColor` | `"#ffffff"` | Any CSS color. |
| `textFontSizeUnit` | `"px"` | `"px"` uses `textFontSize`; `"pct"` uses `textFontSizePct`. |
| `textFontSize` | `96` | Composition pixels (8–1000), used only in `"px"` mode. 96 is title-size at 1080p; captions are commonly 52–72px. A render at another size **with the project's aspect ratio** (720p / 4K of a 1080p project) scales it with the rest of the frame. Only a render at a **different** aspect ratio, which reflows the composition to the new frame, keeps the absolute px (see Output size in `video-rendering.md`). |
| `textFontSizePct` | `8.9` | Font size as % of the **composition height** (0.5–100), used only in `"pct"` mode: `5.9` equals about 64px at 1080p. Prefer it for API-authored projects that may be rendered at a different aspect ratio: it follows the reflowed frame there, where px does not. Same-aspect renders scale px and pct alike. |
| `textFontFamily` | `"'Helvetica Neue', Helvetica, Arial, sans-serif"` | CSS font stack. |
| `textFontWeight` | `400` | 100–900. Captions read better at 700–800. |
| `textFontStyle` | `"normal"` | `normal` \| `italic`. Slants the whole layer; fonts without a true italic face get the browser's synthesized oblique. |
| `textLineHeight` | `1.15` | 0.7–3. |
| `textLetterSpacing` | `0` | px (−20–80). |
| `textAlign` | `"center"` | `left` \| `center` \| `right`. |
| `textWidthUnit` | `"pct"` | `"pct"` uses `textWidthPct`; `"px"` uses `textWidthPx`. |
| `textWidthPct` | `86` | Text box width as % of the **composition width** (5–100). The box is the wrap width and the left/right-align margin. 86 is the legacy default box. |
| `textWidthPx` | `null` | Text box width in composition pixels (40–20000), used only in `"px"` mode. |
| `textNoWrap` | `false` | `true` = white-space nowrap: never auto-wrap, only explicit `\n` line breaks start a new line. The box width is ignored. Overflowing text is NOT clipped — the layer's texture grows to the content (up to 4× the composition width), so a zoom-out or a camera/pan move can travel across a long single line. |
| `textWrapAnywhere` | `false` | `true` = a line may break between any two characters (mid-word) to fit the box. Ignored with `textNoWrap`. |
| `panX` | `0` | **Horizontal position**, % of the frame WIDTH from center (±50 = the frame edge; no limit, beyond that is off-frame). + = right. |
| `panY` | `0` | **Vertical position**, % of the frame HEIGHT from center (±50 = the frame edge; no limit). **+ = down**, − = up. Bottom caption ≈ **`panY: 35`** (≈ `38` sits lower). |

Text extras: `textBgEnabled` + `textBgColor` + `textBgPadding` draw a caption-style background bar behind each text line (padding in px — the "spacing" around the text). `textBgPaddingX` / `textBgPaddingY` (px, 0–200) set the horizontal and vertical spacing separately — the panel's **Spacing H / Spacing V** — and each falls back to `textBgPadding` when omitted or `null`, so setting only the legacy field still moves both axes. The same bar can carry a border: `textBorderEnabled: true` + `textBorderColor` (default `"#ffffff"`, rgba allowed) + `textBorderWidth` (px, 0.5–40, default 2) + `textBorderStyle` (`"solid"` default, `"dashed"`, `"dotted"`). The border is its own toggle — a bar can be outline-only (`textBorderEnabled` without `textBgEnabled`) — and is stroked INSIDE the bar's bounds, so width never grows the bar. `textBgRadius` (px, 0–200) sets the bar's corner radius for both fill and border; omit it (or `null`) for the automatic radius (the padding, capped at 40% of the font size and 40px). The bar can animate instead of appearing instantly: `textBgInType` / `textBgOutType` pick the reveal — `"none"` (default), `"fade"`, `"mask-right"`, `"mask-left"`, `"mask-down"`, `"mask-up"`, `"center-h"`, `"center-v"`. Mask names give the direction the motion travels for In and Out alike (In `"mask-right"` sweeps the bar on left→right, Out `"mask-right"` sweeps it away left→right, so the same value both ways reads as one continuous pass); `center-*` grow/shrink each bar about its middle. `textBgInStyle` / `textBgOutStyle` are `"wipe"` (default — the finished bar is clipped by a rectangle, so the leading edge is flat), `"slide"` (the fill slides behind a mask fixed at the bar's final shape; `mask-*` only) or `"grow"` (**Grow Shape** — the bar's own rounded geometry scales from the anchored edge, so the corner radius is preserved throughout; pick this for pill-shaped bars). `center-*` take `wipe` or `grow`. Grow Shape extends a **seed** sitting at the anchored edge: the seed is `textBgInGrowStart` / `textBgOutGrowStart` (px, 0–600, default 0) when set, otherwise the pill's diameter when the bar has a radius (a circle), otherwise a hairline caret — so the fill really starts at ~0 width. Grow Shape can also give the seed its own appearance: `textBgInGrowAppear` / `textBgOutGrowAppear` — `"none"` (default: the seed is there from the first frame and extends), `"fade"` (alphas in while extending), `"scale-in"` (the seed zooms from a dot **at the start point** — dot → caret line, or dot → circle with a radius — and only then extends along the direction; the two run one after the other, so the total In takes appear-duration + duration) or `"scale-down"` (settles from 150% about the start point while fading in) — with `textBgInGrowAppearDuration` / `textBgOutGrowAppearDuration` (s, 0.05–4, default 0.4) and `textBgInGrowAppearEasing` / `textBgOutGrowAppearEasing` (easing display values, defaults `"Ease Out"` / `"Ease In"`). Nothing scales about the moving box centre, so the shape never drifts. Out mirrors everything (retract to the seed, then the seed zooms away). Ignored unless the slot's style is `"grow"`. `textBgInDuration` / `textBgOutDuration` are seconds (0.05–4, defaults 0.5 / 0.4); In plays over the item's first seconds, Out over its last. `textBgInDelay` (s, 0–4, default 0) holds the bar off-screen for that long before the In reveal starts — use it when the bar should land after the words have begun animating. The reveal (and the delay) applies to the border-only bar too. `textBgInEasing` / `textBgOutEasing` take an easing **display value** such as `"Ease Out"`, `"Expo Out"`, `"Back Out"` — the same values as `transitionInEasing` (defaults `"Ease Out"` in, `"Ease In"` out). Also: `textShadowX`/`textShadowY`/`textShadowBlur`/`textShadowColor` add a text shadow (defaults 0 / `rgba(0,0,0,0.75)`; off while offset and blur are all 0), with `textShadowSpread` (px, 0–50, default 0) thickening it before the blur. `textLetterCase` re-cases the rendered glyphs without touching `textContent` — `"none"` (default), `"uppercase"`, `"lowercase"` or `"capitalize"`, so a caption can shout without the stored text shouting. `textDecoration` is `"none"` (default), `"underline"`, `"line-through"` or `"overline"`. `textClipMask: true` turns the layer into a clipping mask so footage below plays inside the letters — see **Clipping masks** in the shapes section.

**Fill style / outline type.** `textFillMode` is `"fill"` (default, solid glyphs), `"outline"` (hollow glyphs — the glyph boundary only) or `"both"`. `textOutlineWidth` is the stroke width in px on the text canvas (0–60, default 2; outline modes never go below a 0.5px hairline). `textOutlineColor` is optional — **omit it and the outline uses `textColor`**, so switching mode never silently changes the layer's colour; set it for a contrasting rim in `"both"` mode. Gradients work on the outline exactly as they do on the fill.

Use `textFillMode: "outline"` when putting **Running Glow** on type (see the Layer effects section): the glow draws on the glyph boundary, and a filled glyph swamps it, whereas a hollow glyph is nothing but boundary. A very thin outline gives the effect little to grab — 3px+ at title sizes, or raise `glowRadius`.

Field groups for the look around the text (the motion itself is `textAnimators`):

| Group | Fields |
| --- | --- |
| Caption bar look | `textBgEnabled` + `textBgColor` (fill), `textBgPadding` or per-axis `textBgPaddingX` / `textBgPaddingY` (px), `textBorderEnabled` + `textBorderColor` + `textBorderWidth` (px) + `textBorderStyle` (`solid`\|`dashed`\|`dotted`), `textBgRadius` (px, omit for auto) — full semantics under **Text extras** above |
| Caption-bar reveal (needs `textBgEnabled` or `textBorderEnabled`) | `textBgInType` / `textBgOutType` (`none`\|`fade`\|`mask-right`\|`mask-left`\|`mask-down`\|`mask-up`\|`center-h`\|`center-v`), `textBgInStyle` / `textBgOutStyle` (`wipe`\|`slide`\|`grow` — grow keeps the corner radius while the bar scales), `textBgInGrowStart` / `textBgOutGrowStart` (px, grow only — start size), `textBgInGrowAppear` / `textBgOutGrowAppear` (`none`\|`fade`\|`scale-in`\|`scale-down`, grow only) + `…GrowAppearDuration` (s) + `…GrowAppearEasing`, `textBgInDelay` (s, 0–4, default 0 — wait before the In starts), `textBgInDuration` / `textBgOutDuration` (s, 0.05–4, defaults 0.5/0.4), `textBgInEasing` / `textBgOutEasing` (easing **display values** like `"Expo Out"`) — animates the background bar in/out so it doesn't pop in while the words are still animating. Full semantics under **Text extras** above |
| Text Randomizer (static per-unit styling, seeded) | `textRandomEnabled` (bool), `textRandomScope` (`words`\|`lines`\|`symbols` — which units get their own style), `textRandomDist` (`uniform`\|`gaussian`\|`nth`\|`wave` — how the variation is distributed across units; `nth` accents every `textRandomNth`-th unit (2–12), `wave` rolls a sine across the text), `textRandomSeed` (0–99999 — same seed = same look; change to reshuffle), `textRandomSizeEnabled` + `textRandomSizeMin`/`textRandomSizeMax` (% of the base font size, 20–300, defaults 80/145), `textRandomColorEnabled` + `textRandomColors` (array of hex/rgba, any count, default `["#33efab"]`) + `textRandomCoverage` (0–100 % — the share of units that get a colour; the rest keep `textColor`), `textRandomWeightEnabled` + `textRandomWeights` (array from 100–900, e.g. `[300, 700]` — each unit draws one), `textRandomItalicEnabled` + `textRandomItalicMode` (`mix`\|`all`) + `textRandomItalicShare` (0–100 % — `mix` only) |

**Voice-synced captions.** Caption items produced by the AI Captions, per-take Captions and AI Shorts flows carry `textWordTimings` — an array with **exactly one `{ "startMs": int, "endMs": int }` entry per whitespace word of `textContent`**, in item-source-local milliseconds (0 = the item's untrimmed start). An animator with `range.drive: "voice"` gives every word (or letter, or line) its turn when it is spoken — see **Drive by Time / Voice** under Advanced Animations. When `textWordTimings` is missing or its length no longer matches the word count of `textContent` (the caption text was edited), a voice animator runs as `time`; the timings stay stored, so restoring the text restores the sync. Attach your own `textWordTimings` (item-local ms, exactly one entry per whitespace word) to any caption item to get the same behaviour.

**Voice link (`textVoiceSource`).** A text layer can name the audio / video / voice layer whose speech times its words: `"textVoiceSource": { "itemId": "<that timeline item's id>", "clipId": "<its clip id>" }` (the app also stores `text`, `at`, `srcAt`, `matched`, `total` — what the last sync saw). The editor's **Advanced Animations ▸ Voice** panel derives `textWordTimings` from it: the layer's words are matched against the source's transcript (`item.aiData.transcribe.words`, else `clip.transcript.words`, seconds) where both layers sit on the timeline (trim and speed curve included), loosely enough that a corrected spelling, an inserted or a dropped word still lands; unmatched words are placed between their matched neighbours. **Resync** redoes it after the text is edited or either layer moves, **Resync all** for every layer on the same voice, **Move to its words** places a layer whose words are spoken elsewhere. **Link all on this track** gives every other text layer of the same track the same voice (captions made before links existed). Captions made by AI Captions and the Transcribe panel are linked when created. When you write a caption yourself, either compute `textWordTimings` directly, or set `textVoiceSource` (`itemId` + `clipId`) and tell the user to press Resync in the Voice panel — the link alone does not re-time anything until a sync runs.

**Text Randomizer.** The `textRandom*` fields give each word/letter/line its own size, colour, font weight and italic — a deterministic, seeded "ransom note / editorial mix" look. It works on static text and composes with Advanced Animations: units are styled first, the animators then run on the styled result. The distribution value drives size, weight **and** colour eligibility together (the top `textRandomCoverage` % of units get a colour), so with `dist: "nth"` the accented units are the same across all properties. Ready-to-paste example (three-colour ransom-note letters):

```json
{
  "textRandomEnabled": true, "textRandomScope": "symbols", "textRandomDist": "uniform", "textRandomSeed": 33,
  "textRandomSizeEnabled": true, "textRandomSizeMin": 75, "textRandomSizeMax": 165,
  "textRandomColorEnabled": true, "textRandomColors": ["#ffd166", "#ff6b81", "#7aa2ff"], "textRandomCoverage": 60,
  "textRandomWeightEnabled": true, "textRandomWeights": [400, 700, 900],
  "textRandomItalicEnabled": true, "textRandomItalicMode": "mix", "textRandomItalicShare": 30
}
```

### Dynamic text placeholders

`{{{TYPE:args}}}` tokens inside `textContent` make parts of an ordinary text layer (`mediaType: "text"`) dynamic while the rest stays typed text. Font, colour/gradient, outline, shadow, background bar, randomizer, text on path and Advanced Animations all apply. A token that doesn't parse — or a VAR with no value — stays visible as typed. Layer names and the timeline show a resolved value instead of the token.

| Token | What it does |
|---|---|
| `{{{COUNTER:0-100}}}` | A number animating between two values. Format follows the typed range: `1,000-25,000` separators · `0.0-99.9` decimals (max 4) · `00-59` zero-padded · `100-0` counts down · `-50..50` negatives (`..`, `to`, `–` also separate) · `250` alone = 0 → 250. |
| `{{{TIMER:05:00-00:00}}}` | A clock: `ss`, `mm:ss` or `h:mm:ss`, optional `.s` decimals. One value alone (`05:00`) counts down to zero. Runs in real time by default; same styles as COUNTER. |
| `{{{CYCLE:fast\|simple\|yours}}}` | Words take turns: each holds `hold` s, then rolls/fades/blurs to the next over `duration` s. |
| `{{{SCRAMBLE:Access granted}}}` | Random characters decoding into the text one by one; keeps its final width the whole time. |
| `{{{VAR:product}}}` | A PROJECT variable — `data.textVariables: [{ "name": "product", "value": "GreenLight" }]` at the top level of the project data (names unique ignoring case). Expands to plain text, so it wraps and animates like typed words. |
| `{{{MARKER}}}` / `{{{MARKER:Intro}}}` | The name of the last timeline marker (`data.markers`) the playhead passed; the argument is shown before the first one (and for an unnamed marker). Plain text, like VAR. |
| `{{{TIMECODE}}}` | The timeline time `hh:mm:ss:ff` in equal digit cells. Arguments: `clip` (time since the layer started) and/or a format `hh:mm:ss`, `mm:ss`, `mm:ss:ff`, `ss:ff`, `ss` — e.g. `{{{TIMECODE:clip mm:ss}}}`. |
| `{{{FRAME}}}` / `{{{FRAME:clip}}}` | The frame number (project, or from the layer's start). |

**Each placeholder's own settings go INSIDE its token**, after `;` as `key=value` pairs — write only what differs from the default (the inspector's PLACEHOLDERS cards write exactly this, and remove an option when it is reset). Settings therefore travel with the text:

```
Orders {{{COUNTER:0-2,480; style=roll; duration=2.5; easing=expo_out}}} in {{{TIMER:05:00; duration=10}}}
{{{CYCLE:fast|simple|yours; style=fade; hold=0.8; loop=off}}}   {{{SCRAMBLE:Access granted; chars=binary; order=random}}}
```

| Type | Options (defaults) |
|---|---|
| COUNTER | `style` odometer\|roll\|count (odometer) · `start` s (0) · `duration` s (1.8) · `easing` a TransitionEasing key in lowercase, e.g. `power3_out` (power3_out) · `width` fixed\|fit (fixed) · `digits` tabular\|natural, Count only (tabular) · `turns` 0–10 (3) · `lands` left\|right\|together (left) · `cascade` 0–90 % (45) · `direction` auto\|up\|down (auto) · `blur` 0–100 % (35) · `kf` a track id |
| TIMER | the same keys; defaults are a real clock: `style` count, `duration` = the timer's own span (05:00 → 300 s), `easing` linear |
| CYCLE | `style` roll\|fade\|blur (roll) · `start` (0) · `hold` s per word (1.2) · `duration` transition s (0.45) · `easing` (power3_out) · `width` fit\|fixed (fit) · `direction` up\|down, roll only (up) · `loop` on\|off (on) |
| SCRAMBLE | `start` (0) · `duration` (1.2) · `chars` symbols\|letters\|digits\|binary\|blocks (symbols) · `order` ltr\|rtl\|random (ltr) · `flicker` glyph changes/s (18) |
| TIMECODE / FRAME | no options — `clip` and the format are the token body (`{{{TIMECODE:clip mm:ss}}}`) |

- Styles: `odometer` — each digit column rolls on its own from start digit to end digit, `turns` extra spins on the rightmost column, columns landing in a cascade; `roll` — a mechanical odometer (the last digit spins fastest, carries turn the next column; a timer's seconds-tens wheel has six digits); `count` — the digits just change.
- Timing is seconds on the item's **source** clock (`trimStart` + clip time). `width: fixed` reserves room for the widest value (nothing around it moves); `fit` closes the gap so neighbouring words slide.
- Keyframed progress: `kf=<id>` makes the placeholder follow `propertyKeyframes["ph:<id>"]` (values `"0"`–`"100"`, % of the way from start to end) instead of start/duration/easing — e.g. `{{{COUNTER:0-100; kf=1}}}` with a `ph:1` track. Each placeholder can have its own.
- Unknown or malformed options are ignored (the token still renders). The layer fields `textCounter*` / `textCycle*` / `textScramble*` and the layer-wide `textCounterProgress` track are legacy (10.10.32–36) — still honoured as the base for tokens without options, but new work should use token options.

### Advanced Animations — effects over a moving range of characters, words or lines

**Start from a preset recipe** before building animators from scratch: the app's presets are ready JSON, tuned in the app.
- Energetic text (a title, hook, promo or social line, anything punchy, bouncy or kinetic): [video-text-kinetic.md](video-text-kinetic.md) — 21 in-and-out animations (Swing Pop and its family).
- Everything else: [video-text-presets.md](video-text-presets.md) — 46 recipes. Sweep Reveal (typing under a colour band), Type on Shape (text typed onto a pill, card or bar that grows with it), Emphasis (one highlight pass), Loop (neon, rainbow, float, flicker), Characters (decode, binary, glitch) and Voice (caption karaoke on `textWordTimings`).

**Pace:** an entrance, an exit or a one-time pass takes at least 0.8–1 s by default, from the first unit starting to the last one settling. On Time that span is `(units − 1) × stagger + duration`. Go faster only when the edit needs it. The rule and its exceptions are in [video-projects.md](video-projects.md#text-animation-pace).

The After Effects text-animator model on a text layer (stored as `textAnimators`). `item.textAnimators` is a list of animators; each one **selects** units of the text with a range (plus an optional wiggle) and applies its **effects** to them. Every effect value is what a unit gets at 100 % selection; the unit's selection amount (−1…1) scales it. What moves the selection is the range's `drive`: `range` (default) = Start / End / Offset, animated with `txa:` keyframe tracks or with `flow` for an endless keyframe-free travel; `time` = every unit takes its turn in seconds (a stagger, with In / Out and a highlight clock); `voice` = every unit takes its turn when it is spoken (captions). Renders identically in preview, `/render-onserver` and stills.

`textAnimators` is the only text animation. Never write `textSplit*`, `splitIn*`, `splitOut*`, `textHighlight*` or `textCaret*` fields, or `textRevealProgress` / `textHighlightColor` tracks: the app ignores them. A stored project that still carries them is converted into `textAnimators` when the app loads it, so a `GET` of a project nobody has opened since may still show them.

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
| `flow` | −400…400 (0) | Offset added per second (%/s or units/s) — continuous travel without keyframes. |
| `loop` | bool (false) | The span wraps around the ends (pair with `flow` for an endless pass). Under `time`: the cascade repeats. |

**Drive by Time / Voice.** Every unit gets its own clock instead of a moving span; no keyframes, and the seconds are anchored to the layer's start (In) and end (Out), so trimming a layer never stretches the motion.

| Field | Values (default) | Meaning |
|---|---|---|
| `animate` | `in` \| `out` \| `inOut` \| `active` \| `stay` (`in`) | `in`: units arrive FROM the effects (amount 1 → 0 over `duration` from the unit's turn). `out`: units leave INTO them; the turns run on the layer clock and the last unit finishes exactly at the layer end (− `delay`). `inOut`: both, same effects. `active`: the effects light each unit in turn (0 → 1 at its turn, back to 0 after `hold`). `stay`: lit from its turn on. |
| `order` | `forward` \| `backward` \| `center` \| `edges` \| `random` (`forward`) | Time: which unit goes first (`random` uses `seed`). |
| `delay` | −60…600 s (0) | In: after the layer starts. Out: before it ends. Voice: after the word is spoken (negative = before). |
| `stagger` | 0…10 s (0.06) | Time: between one unit's turn and the next. |
| `duration` | 0…20 s (0.6) | How long each unit takes (0 = instant). For `active`/`stay` it is the fade-in. |
| `curve` | the app's easing names (`Ease Out`) | Each unit's own easing: `Linear`, `Ease In/Out`, `Smooth`, `Power1–4 In/Out/Smooth`, `Sine/Cubic/Expo/Circ/Back In/Out/Smooth`, `Bounce Out`, `Elastic`, `Overshoot`, `Smooth Overshoot`, `Impulse`, `Swing`, `Anticipate`, `Natural`, `Slow Down`, `AE In/Smooth/Out`. Back, Bounce, Elastic and the Overshoots land each unit past its rest and settle (transforms follow the overshoot, colours clamp). `Anticipate` is an exit: the unit winds back the other way (to −0.38 of the move at 58 %), then snaps through in the last frames. |
| `hold` | 0…600 s (0) | `active`: how long a unit stays lit; 0 = until the next unit's turn (voice: until the next word starts). |
| `fadeOut` | 0…20 s (0) | `active`: fade back down after `hold`. |
| `keepLast` | bool (false) | `active`: the last unit stays lit. |
| `spread` | bool (true) | Voice + `chars`/`charsNoSpace`: the letters of a word take their turns across the time the word is spoken (typed at speaking pace); false = the whole word together. |

`voice` reads the item's `textWordTimings` (one `{ startMs, endMs }` per whitespace word, item-source ms — captions made from a transcript carry them). A line's turn spans its first word's start to its last word's end. With no timings, or not one per word (the text was edited), the animator runs as `time` — restoring the text restores the sync. An `out` side always runs on time. Under `time`, unit i starts at `delay + i × stagger`; an `out` cascade ends with the layer.

**Wiggle** (`wiggle`, off unless `enabled`): a smooth random selection between `min` and `max` % that changes `rate` times a second, combined with the range by `mode` (`intersect` = only inside the range, `add`, `subtract`, `min`, `max`, `difference`). `corr` 0–100 % makes units wiggle together; `tPhase`/`sPhase` −360…360° offset it in time / across units; `seed` picks the pattern.

**Effects** (`effects[]`, applied top to bottom; animators apply in list order). Transforms from every animator add up per unit and turn around the layer pivot above:

| `type` | Fields (default) | How the selection applies |
|---|---|---|
| `position` | `x` 0, `y` −80 px | adds value × amount |
| `scale` | `scale` 160, `x` 100, `y` 100 % | 100 % → value, multiplies |
| `rotation` | `angle` 45° | adds |
| `rotate3d` | `x` 90, `y` 0°, `perspective` 800 px | adds; real perspective, a camera `perspective` px in front of the unit (0 = flat). +X tips the top away, +Y the right side |
| `skew` | `skew` 25°, `axis` 0° | adds |
| `tracking` | `amount` 40 px | adds space around the unit; the row reflows and re-aligns |
| `opacity` | `opacity` 0 % | 100 % → value, multiplies |
| `fill` | `color` `#ffd84d`, `mix` 100 % | mixes the unit's colour toward `color` |
| `gradient` | `colors` (2–6 hex), `angle` 0°, `span` `text`\|`unit`, `shift` 0 %, `repeat` false, `mix` 100 % | paints the unit with the gradient (across the whole text or each unit); `shift` slides the colours, `repeat` lets them loop |
| `hue` | `hue` 180°, `saturation` 0, `brightness` 0 % | rotates whatever colour the unit has at that point |
| `stroke` | `color` `#ffffff`, `width` 4 px, `outline` false | outline around the glyphs; `outline: true` fades the fill out |
| `glow` | `color` `#5ef2ff`, `size` 30 px, `strength` 120 % | soft light around the glyphs |
| `shadow` | `color` `#000000`, `x` 0, `y` 18, `blur` 20 px, `opacity` 70 % | offset shadow |
| `blur` | `amount` 18 px | defocus |
| `box` | `color` `#33efab`, `behind` `selected`\|`revealed`, `shape` `line`\|`unit`\|`block`, `padX` 12, `padY` 4, `radius` 10 px, `opacity` 100 %, `grow` true, `withText` false | `line`: one bar behind each run of selected units in a row; `unit`: a bar behind each selected unit of `basedOn` (a whole word even when drawn by letters), as bright as its amount; `block`: one shape around all of it. `behind: revealed` = behind what this animator lets through (a typing animator grows its box). `grow` makes a moving span sweep it like a marker. `withText` (`unit` only): each bar is as visible as its unit — every animator's opacity included — so a word that has not appeared yet has no bar |
| `caret` | `style` `bar`\|`underscore`\|`block`, `ownColor` false, `color`, `width` 0 (auto) px, `blink` 1.1/s, `hide` false, `hideAfter` 0 s | a text cursor at this animator's reveal edge (what an Opacity 0 on the same range lets through): on an `in` animator it types with the text; solid while typing, blinking otherwise, gone when an `out` starts or `hideAfter` s after the typing ends |
| `scramble` | `charset` `upper`\|`lower`\|`digits`\|`alnum`\|`symbols`\|`binary`\|`blocks`, `rate` 18/s, `seed` 1 | a unit shows random glyphs with probability = its selection |
| `charOffset` | `offset` 6 | shifts letters/digits by `round(offset × amount)` through the alphabet |

Colours are `#rrggbb`. On a text layer used as a clip mask (`textClipMask`), `glow`, `shadow` and `box` are skipped (they would become coverage). `box` is not drawn on text on a path.

**Keyframes.** `propertyKeyframes["txa:<aid>:<chan>"]`, the usual `{ position, value, easing }` keys, value in the field's own units:
- range: `start`, `end`, `offset`, `amount`, `smooth`, `easeHigh`, `easeLow` (under `time`/`voice` only `amount`)
- wiggle: `wig.max`, `wig.min`, `wig.corr`
- effect: `<pid>.<field>` for any numeric effect field except `scramble`'s `rate`/`seed` (e.g. `txa:a1:p2.y`)

Rates (`flow`, wiggle `rate`) and seeds are not keyframable. A track whose animator or effect no longer exists is dropped on load.

Worked examples (spread onto a text item; durations assume a 4 s layer):

```jsonc
// Colour sweep: a yellow, slightly raised band travels across the letters once.
"textAnimators": [{ "aid": "a1", "name": "Sweep", "range": { "end": 14, "shape": "smooth" },
  "effects": [ { "pid": "p1", "type": "fill", "color": "#ffd84d" }, { "pid": "p2", "type": "position", "x": 0, "y": -16 } ] }],
"propertyKeyframes": { "txa:a1:offset": [ { "position": 5, "value": "-14", "easing": "Smooth" }, { "position": 80, "value": "100", "easing": "Smooth" } ] }

// Cascade in: letters drop and spin into place left to right (rampUp = everything after the span is still hidden).
"textAnimators": [{ "aid": "a1", "name": "Cascade", "range": { "end": 30, "shape": "rampUp" },
  "effects": [ { "pid": "p1", "type": "position", "x": 0, "y": -140 }, { "pid": "p2", "type": "rotation", "angle": -35 },
               { "pid": "p3", "type": "opacity", "opacity": 0 } ] }],
"propertyKeyframes": { "txa:a1:offset": [ { "position": 0, "value": "-30", "easing": "Smooth" }, { "position": 85, "value": "100", "easing": "Smooth" } ] }

// Type in under a colour band (how the Sweep Reveal presets work; the exact ones are in video-text-presets.md): letters fade in one by one while falling
// into place, and a second animator's band (start 20, end 80, smooth) runs across in a warm colour.
// Offset −80 parks the band before the text and +80 past it, so the text starts and ends in its own colour.
"textAnimators": [
  { "aid": "a1", "name": "Fade down", "range": { "end": 8, "shape": "rampUp" },
    "effects": [ { "pid": "p1", "type": "position", "x": 0, "y": -30 }, { "pid": "p2", "type": "opacity", "opacity": 0 } ] },
  { "aid": "a2", "name": "Ember band", "range": { "start": 20, "end": 80, "shape": "smooth" },
    "effects": [ { "pid": "p3", "type": "fill", "color": "#e8892b" } ] }],
"propertyKeyframes": {
  "txa:a1:offset": [ { "position": 0, "value": "-8", "easing": "Linear" }, { "position": 45, "value": "100", "easing": "Linear" } ],
  "txa:a2:offset": [ { "position": 7.5, "value": "-80", "easing": "Sine Smooth" }, { "position": 75, "value": "80", "easing": "Sine Smooth" } ] }

// Endless neon pass: a glowing band loops across dim text with no keyframes.
"textColor": "#56646f",
"textAnimators": [{ "aid": "a1", "name": "Neon", "range": { "end": 26, "shape": "triangle", "flow": 36, "loop": true },
  "effects": [ { "pid": "p1", "type": "fill", "color": "#f2ffff" }, { "pid": "p2", "type": "glow", "color": "#36f1ff", "size": 36, "strength": 180 } ] }]

// Fade Up (Time): words rise in 0.06 s apart, and leave upward at the end.
"textAnimators": [
  { "aid": "a1", "name": "In", "range": { "drive": "time", "animate": "in", "basedOn": "words", "stagger": 0.06, "duration": 0.8, "curve": "Power2 Smooth" },
    "effects": [ { "pid": "p1", "type": "position", "x": 0, "y": 50 }, { "pid": "p2", "type": "opacity", "opacity": 0 } ] },
  { "aid": "a2", "name": "Out", "range": { "drive": "time", "animate": "out", "basedOn": "words", "stagger": 0.06, "duration": 0.7, "curve": "Power2 Smooth" },
    "effects": [ { "pid": "p3", "type": "position", "x": 0, "y": -50 }, { "pid": "p4", "type": "opacity", "opacity": 0 } ] }]

// Energetic in and out (Swing Pop and 20 more, each two Time animators): video-text-kinetic.md.
// Every other app preset (typing reveals, text on shapes, highlights, loops, decoders, voice): video-text-presets.md.

// Caption karaoke on the voice (needs textWordTimings): a box sits under each word while it is spoken.
"textAnimators": [{ "aid": "a1", "name": "Spoken box", "range": { "drive": "voice", "animate": "active", "basedOn": "words", "duration": 0.08, "curve": "Power2 Out", "fadeOut": 0.08 },
  "effects": [ { "pid": "p1", "type": "box", "color": "#33efab", "padX": 12, "padY": 4, "radius": 14, "grow": false }, { "pid": "p2", "type": "fill", "color": "#0b0d0c" } ] }]

// Letters typed at speaking pace behind a caret (captions).
"textAnimators": [{ "aid": "a1", "name": "Type", "range": { "drive": "voice", "animate": "in", "basedOn": "chars", "duration": 0.04, "curve": "Linear", "spread": true },
  "effects": [ { "pid": "p1", "type": "opacity", "opacity": 0 }, { "pid": "p2", "type": "caret", "style": "bar" } ] }]

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
            { "aid": "a1", "name": "In", "range": { "drive": "time", "animate": "in", "basedOn": "words", "stagger": 0.06, "duration": 0.8, "curve": "Power2 Smooth" },
              "effects": [ { "pid": "p1", "type": "position", "x": 0, "y": 50 }, { "pid": "p2", "type": "opacity", "opacity": 0 } ] },
            { "aid": "a2", "name": "Out", "range": { "drive": "time", "animate": "out", "basedOn": "words", "stagger": 0.06, "duration": 0.7, "curve": "Power2 Smooth" },
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

`sanitizeTimelineItem` fills every omitted field (transitions, filters, opacity, etc.) with defaults, so the caption item above is complete. For multiple captions, reuse the channel only when their visible windows do **not** overlap. Any lines that must appear together (for example eyebrow + headline + sub-caption) need separate channels, one live item per channel.

3.  To produce the finished file with the caption burned in, `POST /api/moodboards/{board_id}/video-projects/{project_id}/render-onserver` — the full headless renderer bakes the animated caption in (the fast `/render` won't). Optionally `.../activate` first so it also opens as the board's active project.

* * *
