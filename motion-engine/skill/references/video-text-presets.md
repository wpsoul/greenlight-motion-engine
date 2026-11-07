> **GreenLight Motion Engine:** this is the GreenLight Dash Video Editor's project format, which the engine reads as is.
> Ignore the `/api/...` routes and the app UI described here: in the engine you edit `project.json` (or `apply`) and run
> `npx greenlight-motion build`; what `GET /api/video-editor/capabilities` returns there is `npx greenlight-motion schema <topic>`
> here. `frontend/src/…` paths are files of the engine's public source repository. MotionFast templates (`mediaType: "motion"`)
> stay in GreenLight Dash.

# GreenLight Dash — Text animation presets: typing reveals, text on shapes, highlights, loops, decoders, voice captions, classic reveals

> Builds on [video-text.md](video-text.md#advanced-animations--effects-over-a-moving-range-of-characters-words-or-lines) (the `textAnimators` model). Read that for the fields; this file is the app's own preset catalogue as JSON to paste. Energetic in-and-out titles are in [video-text-kinetic.md](video-text-kinetic.md).

## Contents

- [Pick a category](#pick-a-category)
- [Writing a recipe onto a layer](#writing-a-recipe-onto-a-layer)
- [The catalogue](#the-catalogue)
- Recipes: [Sweep Reveal](#sweep-reveal) · [Type on Shape](#type-on-shape) · [Emphasis](#emphasis) · [Loop](#loop) · [Characters](#characters) · [Voice](#voice)
- [Classic](#classic): 29 calm word and letter reveals, highlights, caption bars and randomizer looks

## Pick a category

Start from a preset whenever one fits, then adjust its colours and timing. The presets are tuned in the app, and an
animator built from scratch rarely looks as good.

| The text should… | Category |
|---|---|
| type in letter by letter while a colour band passes over it (a headline, a prompt, a typed statement) | [Sweep Reveal](#sweep-reveal) |
| pop, swing, spin or bounce in and out (a title, a hook, a promo line) | Kinetic, in [video-text-kinetic.md](video-text-kinetic.md) |
| type onto a pill, card, bar or marker that grows with it (lower thirds, labels, chat bubbles), or erase with it | [Type on Shape](#type-on-shape) |
| get one highlight pass while it is on screen (a colour band, glow, wave, marker) | [Emphasis](#emphasis) |
| keep moving for the whole layer with no keyframes (neon, rainbow, gradient, float, jitter, flicker) | [Loop](#loop) |
| resolve out of random glyphs, binary or a rolling alphabet, or keep glitching | [Characters](#characters) |
| follow speech in a caption (karaoke box, word pops, read-along) | [Voice](#voice) |
| come in calmly word by word or letter by letter, optionally with a highlight, a caption bar or a randomizer look (captions, lower thirds, a typewriter, a ransom note) | [Classic](#classic) |

Recipes combine: a layer holds up to 8 animators, so an entrance plus an Emphasis or Loop recipe on the same text
works. Append the second recipe with fresh ids (next section).

Preferred presets: once the table has given the category, and the user has not named a preset, choose from these
first:

- Sweep Reveal: [Glide Text](#glide-text) (the default text animation), [Ember Type](#ember-type).
  [Glide Continuous](#glide-continuous) and [Glide Soft Stop](#glide-soft-stop) keep the word drifting for the whole
  layer and never let it rest: use them only when the user asks for that.
- Emphasis: [Marker](#marker), [Outline Pass](#outline-pass).
- Loop: [Neon Flow](#neon-flow).
- Characters: [Glitch](#glitch).
- Voice: [Spoken Box](#spoken-box), [Spoken Pop](#spoken-pop), [Spoken Glow](#spoken-glow),
  [Karaoke Wipe](#karaoke-wipe), [Word Pop](#word-pop), [Rise on Voice](#rise-on-voice),
  [Typed as Spoken](#typed-as-spoken).
- Classic: [Classic Fade Up](#classic-fade-up), [Classic Rise (Mask)](#classic-rise-mask) (calm lines and captions).
- Kinetic: see [video-text-kinetic.md](video-text-kinetic.md#when-to-use-them).

Type on Shape has no preferred preset: pick by the shape the text needs.

## Writing a recipe onto a layer

- **Copy** the recipe's `textAnimators` into the text item, plus `textAnimatorPivotX` / `textAnimatorPivotY` when it
  has them, and merge its `propertyKeyframes` into the item's own (the item's other tracks stay).
  - To **replace** the layer's animation, delete the old `textAnimators` and every `txa:` track first, and set both
    pivots to the recipe's values (0 when it has none): recipes reuse ids like `a1`/`p1`, so a leftover track or pivot
    would drive the new animator.
  - To **add** on top, give the new animators and effects `aid` / `pid` values the layer does not use yet, and rename
    the recipe's `txa:<aid>:…` / `<pid>.<field>` track keys to match.
- **Lengths are for a 100 px font.** Multiply every length field listed under [The catalogue](#the-catalogue)
  by the layer's font size in px / 100: `textFontSize`, or in pct mode `textFontSizePct × videoSize.h / 100`. Angles, scales, opacities, percentages and timings stay as written.
  [Classic](#classic) recipes are the exception: their lengths are px and stay as written, apart from the few each
  recipe lists.
- **Keyframe `position` is a % of the layer's length.** Every recipe is written for a **5 s layer**, and each key has
  its time in a comment. For a layer `L` seconds long:
  - `t s` → `position = t / L × 100`
  - `t s before the end` → `position = 100 − t / L × 100`
  - `n % of the layer`, `layer start`, `layer end` → keep the position as written
  - If the recipe's longest key time is more than `L`, first divide every key time by `longest / L`, so the motion
    fits the layer. The app does the same.

  Recipes without `propertyKeyframes` (Voice, the Time-driven parts, and every Loop except Gradient Flow, whose keys
  are layer %) fit any layer length as written.
- **Strip the `//` time comments** from a recipe's blocks before you send it: they are notes, not JSON.
- **Faster or slower** by a factor `k`: divide every key time and every `stagger`, `duration`, `delay`, `hold` and
  `fadeOut` by `k`; multiply `flow`, wiggle `rate` and scramble `rate` by `k`.
- **Colours** in the effects are the recipe's look. The text keeps its own colour, font and size. Some recipes are
  designed for a particular text colour or background, which is noted under them. A recipe with an `Ink` animator
  paints the text itself, so it reads on its shape whatever the layer's colour is.
- **Voice recipes need `textWordTimings`** on the item (captions made from a transcript have them). Without timings
  they run as Time animators, one word after another.
- **To check it**, render a still in the middle of the motion and one after it settles (rendering.md).

## The catalogue

<!-- PRESETS:BEGIN (generated from the app's presets; do not edit by hand) -->

54 recipes in 7 categories; the app's 29 Classic recipes follow in [Classic](#classic). **Lengths** to multiply by the font size in px / 100: `blur` `amount`; `box` `padX`, `padY`, `radius`; `glow` `size`; `position` `x`, `y`, `z`; `rotate3d` `perspective`; `stroke` `width`; and the layer's `textAnimatorPerspective`.

**A fade-out exit for an `in` recipe**, ending with the layer: append this animator with unused ids. Set its `basedOn` to the recipe's first animator's, and `stagger` to 0.015 for letters, 0.04 for words or 0.08 for lines.

```json
{ "aid": "a9", "name": "Out",
  "range": {"drive": "time", "animate": "out", "basedOn": "words", "stagger": 0.04, "duration": 0.3, "curve": "Ease In"},
  "effects": [{"pid": "p19", "type": "opacity", "opacity": 0}] }
```

It is quick by design (0.3 s per unit); raise `duration` when the exit has to be read.

| Recipe | Category | What it does | Unit | Plays |
|---|---|---|---|---|
| [Glide Text](#glide-text) | Sweep Reveal | Letters type in as the word glides left under a chasing blue band and settles, then it slides off to the left | letters | in, the first 1.3 s, then out at the end |
| [Glide Continuous](#glide-continuous) | Sweep Reveal | Letters type in under a chasing blue band as the word keeps gliding through the whole layer, slow in the middle, then slides off to the left | letters | in, the first 1.13 s (Glide in across the whole layer), then out at the end |
| [Smart Overshoot](#smart-overshoot) | Sweep Reveal | Words spring in out of a hot green glow and overshoot into place as the line recentres, and a key word stays lit | words | in, the first 1.8 s on a 5-word line |
| [Glide Soft Stop](#glide-soft-stop) | Sweep Reveal | The same typing and band, but the word glides through the whole layer and all but stops in the middle, then slides off to the left | letters | in, the first 1.13 s (Glide in across the whole layer), then out at the end |
| [Ember Type](#ember-type) | Sweep Reveal | Letters type in falling softly; a warm band trails behind the typing | letters | in, the first 3 s |
| [Molten Edge](#molten-edge) | Sweep Reveal | Letters land glowing hot at the typing edge and cool down behind it | letters | in, the first 2 s |
| [Focus Type](#focus-type) | Sweep Reveal | A long soft wave of letters falls out of a blur under a cool gradient | letters | in, the first 2.9 s |
| [Tumble Type](#tumble-type) | Sweep Reveal | Letters tumble down into place, then a lime band runs over the finished text | letters | in, the first 2.7 s |
| [Flap Down](#flap-down) | Sweep Reveal | Letters swing down from a hinge at their top edge under an amber band | letters | in, the first 2.75 s |
| [Drop Swell](#drop-swell) | Sweep Reveal | Letters drop hard into place; a coral band lifts and swells them as it passes | letters | in, the first 2.7 s |
| [Rain Type](#rain-type) | Sweep Reveal | Letters fall in at random like rain while a blue band runs left to right | letters | in, the first 2.8 s |
| [Counter Sweep](#counter-sweep) | Sweep Reveal | Letters type in left to right while a pink band runs back against them | letters | in, the first 2.7 s |
| [Sunset Shrink](#sunset-shrink) | Sweep Reveal | Big letters shrink down into place; a band paints each one top to bottom in sunset colours | letters | in, the first 2.8 s |
| [Boomerang](#boomerang) | Sweep Reveal | Letters glide down at a slant; a violet band runs out with the typing and swings back | letters | in, the first 3 s |
| [Rack Focus](#rack-focus) | Depth | Words come forward out of a soft background and snap into focus; at the end they pass the focus toward you | words | in, the first 1.78 s on a 5-word line, then out at the end |
| [Stand Up](#stand-up) | Depth | Letters slide forward across the floor and stand up one after another, hinged at their feet; at the end they fall forward toward you | letters | in, the first 1.5 s on a 16-letter line, then out at the end |
| [Strata](#strata) | Depth | Words float in and rest at their own depths while a slow camera drift slides them past each other; at the end they fall back | words | in, the first 1.8 s on a 6-word line (Drift across the whole layer), then out at the end |
| [Spotlight](#spotlight) | Depth | Words wait set back and dim; each in turn steps forward into the light, and the last one keeps it | words | once, the first 2.85 s on a 5-word line |
| [Ripple](#ripple) | Depth | Rings of depth spread from the centre of the text to its edges, over and over, like ripples on still water | letters | loops for the whole layer |
| [Pill Type](#pill-type) | Type on Shape | Letters rise in a soft wave onto a pill that stretches along each line | letters | in, the first 1.6 s |
| [Card Type](#card-type) | Type on Shape | Letters drop in while a white card widens with them, then grows a line taller | letters | in, the first 2 s |
| [Word Bars](#word-bars) | Type on Shape | Words pop up one at a time and the red bar stretches to take each one | words | in, the first 1.6 s |
| [Word Stack](#word-stack) | Type on Shape | Words slide in from the left one at a time and the card grows to take each one | words | in, the first 1.4 s |
| [Marker Type](#marker-type) | Type on Shape | Crisp letters type in one by one, a yellow marker running right at the edge | letters | in, the first 1.8 s |
| [Card Erase](#card-erase) | Type on Shape | Letters shrink away from the end like a backspace and the card shrinks back with them | letters | out, the last 1.4 s |
| [Colour Sweep](#colour-sweep) | Emphasis | A raised yellow band travels across the letters once | letters | once, 0.2 s to 1.8 s |
| [Glow Pass](#glow-pass) | Emphasis | A bright glowing band passes across the text once | letters | once, 0.2 s to 1.8 s |
| [Wave Pass](#wave-pass) | Emphasis | A wave lifts the letters as it rolls through | letters | once, 0.2 s to 1.7 s |
| [Pop Through](#pop-through) | Emphasis | Each word swells in turn as a pulse moves through | words | once, 0.2 s to 2 s |
| [Shine](#shine) | Emphasis | A narrow glint of light runs over the letters | letters | once, 0.3 s to 1.4 s |
| [Marker](#marker) | Emphasis | A highlighter bar sweeps behind the text | letters | once, 0.2 s to 1.2 s |
| [Outline Pass](#outline-pass) | Emphasis | Letters turn into outlines as a band passes over them | letters | once, 0.2 s to 1.8 s |
| [Neon Flow](#neon-flow) | Loop | A glowing band loops across the text without end | letters | loops for the whole layer |
| [Rainbow](#rainbow) | Loop | A rainbow of colour flows through the letters | letters | loops for the whole layer |
| [Gradient Flow](#gradient-flow) | Loop | A colour gradient slides through the text for the whole layer | letters | across the whole layer |
| [Jitter](#jitter) | Loop | Letters shake and twitch on their own | letters | loops for the whole layer |
| [Float](#float) | Loop | Letters bob slowly, as if floating on water | letters | loops for the whole layer |
| [Flicker](#flicker) | Loop | Letters flicker on and off like a failing sign | letters | loops for the whole layer |
| [Breathing Wave](#breathing-wave) | Loop | A gentle swell rolls across the text again and again | letters | loops for the whole layer |
| [Shimmer](#shimmer) | Loop | A warm glint keeps running over the letters | letters | loops for the whole layer |
| [Decode](#decode) | Characters | Random glyphs resolve into the text, left to right | letters | in, the first 1.6 s |
| [Binary Decode](#binary-decode) | Characters | Zeros and ones resolve into the text | letters | in, the first 1.6 s |
| [Alphabet Roll](#alphabet-roll) | Characters | Letters roll through the alphabet and stop on the text | letters | in, the first 1.4 s |
| [Glitch](#glitch) | Characters | Random letters keep breaking into glyphs and jumping | letters | loops for the whole layer |
| [Spoken Box](#spoken-box) | Voice | A box sits under each word while it is spoken, dark text on top | words | while each word is spoken |
| [Spoken Pop](#spoken-pop) | Voice | The spoken word swells and turns gold, then settles back | words | while each word is spoken |
| [Spoken Glow](#spoken-glow) | Voice | The spoken word lights up with a cool glow | words | while each word is spoken |
| [Sung Words](#sung-words) | Voice | Each word turns gold as it is sung and stays gold | words | as each word is spoken |
| [Karaoke Wipe](#karaoke-wipe) | Voice | Colour wipes through each word letter by letter as it is sung | letters | as each letter is spoken |
| [Read Along](#read-along) | Voice | Words wait dimmed and light up as they are said | words | as each word is spoken |
| [Word Pop](#word-pop) | Voice | Each word pops in the moment it is spoken | words | as each word is spoken |
| [Rise on Voice](#rise-on-voice) | Voice | Words rise softly out of a blur as they are spoken | words | as each word is spoken |
| [Bounce on Voice](#bounce-on-voice) | Voice | Words drop in and bounce as they are spoken | words | as each word is spoken |
| [Typed as Spoken](#typed-as-spoken) | Voice | Letters type in at speaking pace behind a caret | letters | as each letter is spoken |

## Sweep Reveal

### Glide Text

Letters type in as the word glides left under a chasing blue band and settles, then it slides off to the left. Plays: in, the first 1.3 s, then out at the end. Designed for a `#05070a` background, left-aligned. Written for text like “External Storage”.

```jsonc
{
  "textAnimators": [
    { "aid": "a1", "name": "Type",
      "range": {"basedOn": "charsNoSpace", "smooth": 0},
      "effects": [{"pid": "p1", "type": "opacity", "opacity": 0}] },
    { "aid": "a2", "name": "Blue band",
      "range": {"basedOn": "charsNoSpace", "start": 0, "end": 100, "shape": "smooth", "easeHigh": 40},
      "effects": [{"pid": "p2", "type": "fill", "color": "#3e59ad"}] },
    { "aid": "a3", "name": "Glide in",
      "range": {"basedOn": "charsNoSpace", "around": "all"},
      "effects": [{"pid": "p3", "type": "position", "x": 250, "y": 0}] },
    { "aid": "a4", "name": "Glide out",
      "range": {"basedOn": "charsNoSpace", "drive": "time", "animate": "out", "around": "all", "stagger": 0, "duration": 0.5, "curve": "Ease In"},
      "effects": [{"pid": "p4", "type": "position", "x": -150, "y": 0}, {"pid": "p5", "type": "opacity", "opacity": 0}] }
  ],
  "propertyKeyframes": {
    "txa:a1:start": [
      { "position": 0, "value": "0", "easing": "AE In (arrive)" },  // 0 s
      { "position": 20, "value": "100", "easing": "Smooth" }  // 1 s
    ],
    "txa:a2:offset": [
      { "position": 6, "value": "-58", "easing": "Sine Out" },  // 0.3 s
      { "position": 26, "value": "101", "easing": "Smooth" }  // 1.3 s
    ],
    "txa:a3:amount": [
      { "position": 0, "value": "100", "easing": "AE In (arrive)" },  // 0 s
      { "position": 20, "value": "0", "easing": "Smooth" }  // 1 s
    ]
  }
}
```

### Glide Continuous

Letters type in under a chasing blue band as the word keeps gliding through the whole layer, slow in the middle, then slides off to the left. Plays: in, the first 1.13 s (Glide in across the whole layer), then out at the end. Designed for a `#05070a` background, left-aligned. Written for text like “External Storage”.

```jsonc
{
  "textAnimators": [
    { "aid": "a1", "name": "Type",
      "range": {"basedOn": "charsNoSpace", "smooth": 0},
      "effects": [{"pid": "p1", "type": "opacity", "opacity": 0}] },
    { "aid": "a2", "name": "Blue band",
      "range": {"basedOn": "charsNoSpace", "start": 0, "end": 100, "shape": "smooth", "easeHigh": 40},
      "effects": [{"pid": "p2", "type": "fill", "color": "#3e59ad"}] },
    { "aid": "a3", "name": "Glide in",
      "range": {"basedOn": "charsNoSpace", "around": "all"},
      "effects": [{"pid": "p3", "type": "position", "x": 250, "y": 0}] },
    { "aid": "a4", "name": "Glide out",
      "range": {"basedOn": "charsNoSpace", "drive": "time", "animate": "out", "around": "all", "stagger": 0, "duration": 0.5, "curve": "Ease In"},
      "effects": [{"pid": "p4", "type": "position", "x": -150, "y": 0}, {"pid": "p5", "type": "opacity", "opacity": 0}] }
  ],
  "propertyKeyframes": {
    "txa:a1:start": [
      { "position": 0, "value": "0", "easing": "AE In (arrive)" },  // 0 s
      { "position": 18.6, "value": "100", "easing": "Smooth" }  // 0.93 s
    ],
    "txa:a2:offset": [
      { "position": 2.8, "value": "-58", "easing": "Sine Out" },  // 0.14 s
      { "position": 22.6, "value": "101", "easing": "Smooth" }  // 1.13 s
    ],
    "txa:a3:amount": [
      { "position": 0, "value": "100", "easing": "Smooth Glide" },  // layer start
      { "position": 100, "value": "-100", "easing": "Smooth" }  // layer end
    ]
  }
}
```

### Smart Overshoot

Words spring in out of a hot green glow and overshoot into place as the line recentres, and a key word stays lit. Plays: in, the first 1.8 s on a 5-word line. Designed for a `#0c0e0d` background. Written for text like “Just the best stablecoin strategies”.

```json
{
  "textAnimators": [
    { "aid": "a1", "name": "Recenter",
      "range": {"basedOn": "words", "drive": "time", "animate": "in", "around": "all", "stagger": 0, "duration": 1.8, "curve": "Cubic Out"},
      "effects": [{"pid": "p1", "type": "position", "x": 462.96, "y": 0}] },
    { "aid": "a2", "name": "Spring in",
      "range": {"basedOn": "words", "drive": "time", "animate": "in", "around": "word", "stagger": 0.15, "duration": 1.1, "curve": "Overshoot"},
      "effects": [{"pid": "p2", "type": "position", "x": 129.63, "y": 157.41}, {"pid": "p3", "type": "scale", "scale": 78}] },
    { "aid": "a3", "name": "Focus in",
      "range": {"basedOn": "words", "drive": "time", "animate": "in", "around": "auto", "stagger": 0.15, "duration": 0.38, "curve": "Ease Out"},
      "effects": [{"pid": "p4", "type": "opacity", "opacity": 0}, {"pid": "p5", "type": "blur", "amount": 25.93}] },
    { "aid": "a4", "name": "Hot glow",
      "range": {"basedOn": "words", "drive": "time", "animate": "in", "around": "auto", "stagger": 0.15, "duration": 0.65, "curve": "Sine Smooth"},
      "effects": [{"pid": "p6", "type": "fill", "color": "#6dff86"}, {"pid": "p7", "type": "glow", "color": "#3dff6a", "size": 62.96, "strength": 230}] },
    { "aid": "a5", "name": "Soft glow",
      "range": {"basedOn": "chars"},
      "effects": [{"pid": "p8", "type": "glow", "color": "#b8ffc6", "size": 22.22, "strength": 30}] },
    { "aid": "a6", "name": "Key word",
      "range": {"basedOn": "words", "start": 60, "end": 85, "smooth": 0},
      "effects": [{"pid": "p9", "type": "fill", "color": "#6dff86"}, {"pid": "p10", "type": "stroke", "color": "#6dff86", "width": 2.41}, {"pid": "p11", "type": "glow", "color": "#3dff6a", "size": 29.63, "strength": 60}] }
  ]
}
```

### Glide Soft Stop

The same typing and band, but the word glides through the whole layer and all but stops in the middle, then slides off to the left. Plays: in, the first 1.13 s (Glide in across the whole layer), then out at the end. Designed for a `#05070a` background, left-aligned. Written for text like “External Storage”.

```jsonc
{
  "textAnimators": [
    { "aid": "a1", "name": "Type",
      "range": {"basedOn": "charsNoSpace", "smooth": 0},
      "effects": [{"pid": "p1", "type": "opacity", "opacity": 0}] },
    { "aid": "a2", "name": "Blue band",
      "range": {"basedOn": "charsNoSpace", "start": 0, "end": 100, "shape": "smooth", "easeHigh": 40},
      "effects": [{"pid": "p2", "type": "fill", "color": "#3e59ad"}] },
    { "aid": "a3", "name": "Glide in",
      "range": {"basedOn": "charsNoSpace", "around": "all"},
      "effects": [{"pid": "p3", "type": "position", "x": 250, "y": 0}] },
    { "aid": "a4", "name": "Glide out",
      "range": {"basedOn": "charsNoSpace", "drive": "time", "animate": "out", "around": "all", "stagger": 0, "duration": 0.5, "curve": "Ease In"},
      "effects": [{"pid": "p4", "type": "position", "x": -150, "y": 0}, {"pid": "p5", "type": "opacity", "opacity": 0}] }
  ],
  "propertyKeyframes": {
    "txa:a1:start": [
      { "position": 0, "value": "0", "easing": "AE In (arrive)" },  // 0 s
      { "position": 18.6, "value": "100", "easing": "Smooth" }  // 0.93 s
    ],
    "txa:a2:offset": [
      { "position": 2.8, "value": "-58", "easing": "Sine Out" },  // 0.14 s
      { "position": 22.6, "value": "101", "easing": "Smooth" }  // 1.13 s
    ],
    "txa:a3:amount": [
      { "position": 0, "value": "100", "easing": "Glide Easing Stop" },  // layer start
      { "position": 100, "value": "-100", "easing": "Smooth" }  // layer end
    ]
  }
}
```

### Ember Type

Letters type in falling softly; a warm band trails behind the typing. Plays: in, the first 3 s. Designed for text `#161411` on a `#f7f0e4` background, left-aligned. Written for text like “Build a premium, modern sports-tech / landing page for a running performance / app with a full-screen cinematic hero / and a bold white headline about speed”.

```jsonc
{
  "textAnimators": [
    { "aid": "a1", "name": "Fade down",
      "range": {"basedOn": "charsNoSpace", "end": 8, "shape": "rampUp"},
      "effects": [{"pid": "p1", "type": "opacity", "opacity": 0}] },
    { "aid": "a2", "name": "Ember band",
      "range": {"basedOn": "charsNoSpace", "start": 20, "end": 80, "shape": "smooth"},
      "effects": [{"pid": "p2", "type": "fill", "color": "#e8892b"}] }
  ],
  "propertyKeyframes": {
    "txa:a1:offset": [
      { "position": 0, "value": "-8", "easing": "Linear" },  // 0 s
      { "position": 36, "value": "100", "easing": "Smooth" }  // 1.8 s
    ],
    "txa:a2:offset": [
      { "position": 6, "value": "-80", "easing": "Sine Smooth" },  // 0.3 s
      { "position": 60, "value": "80", "easing": "Smooth" }  // 3 s
    ]
  }
}
```

### Molten Edge

Letters land glowing hot at the typing edge and cool down behind it. Plays: in, the first 2 s. Designed for a `#0d0c0b` background, left-aligned. Written for text like “Build a premium, modern sports-tech / landing page for a running performance / app with a full-screen cinematic hero / and a bold white headline about speed”.

```jsonc
{
  "textAnimators": [
    { "aid": "a1", "name": "Fade down",
      "range": {"basedOn": "charsNoSpace", "end": 14, "shape": "rampUp"},
      "effects": [{"pid": "p1", "type": "position", "x": 0, "y": -50}, {"pid": "p2", "type": "opacity", "opacity": 0}] },
    { "aid": "a2", "name": "Molten band",
      "range": {"basedOn": "charsNoSpace", "start": 20, "end": 80, "shape": "smooth", "easeHigh": 40},
      "effects": [{"pid": "p3", "type": "fill", "color": "#ffb02e"}, {"pid": "p4", "type": "glow", "color": "#ff5a1f", "size": 18, "strength": 110}] }
  ],
  "propertyKeyframes": {
    "txa:a1:offset": [
      { "position": 0, "value": "-14", "easing": "Linear" },  // 0 s
      { "position": 32, "value": "100", "easing": "Smooth" }  // 1.6 s
    ],
    "txa:a2:offset": [
      { "position": 0, "value": "-80", "easing": "Linear" },  // 0 s
      { "position": 40, "value": "80", "easing": "Smooth" }  // 2 s
    ]
  }
}
```

### Focus Type

A long soft wave of letters falls out of a blur under a cool gradient. Plays: in, the first 2.9 s. Designed for left-aligned text. Written for text like “Build a premium, modern sports-tech / landing page for a running performance / app with a full-screen cinematic hero / and a bold white headline about speed”.

```jsonc
{
  "textAnimators": [
    { "aid": "a1", "name": "Fade down",
      "range": {"basedOn": "charsNoSpace", "end": 32, "shape": "rampUp"},
      "effects": [{"pid": "p1", "type": "position", "x": 0, "y": -25}, {"pid": "p2", "type": "blur", "amount": 12}, {"pid": "p3", "type": "opacity", "opacity": 0}] },
    { "aid": "a2", "name": "Cool band",
      "range": {"basedOn": "charsNoSpace", "start": 20, "end": 80, "shape": "smooth"},
      "effects": [{"pid": "p4", "type": "gradient", "colors": ["#7cf5ff", "#b36bff"], "angle": 0, "span": "text"}] }
  ],
  "propertyKeyframes": {
    "txa:a1:offset": [
      { "position": 0, "value": "-32", "easing": "Sine Smooth" },  // 0 s
      { "position": 38, "value": "100", "easing": "Smooth" }  // 1.9 s
    ],
    "txa:a2:offset": [
      { "position": 8, "value": "-80", "easing": "Sine Smooth" },  // 0.4 s
      { "position": 58, "value": "80", "easing": "Smooth" }  // 2.9 s
    ]
  }
}
```

### Tumble Type

Letters tumble down into place, then a lime band runs over the finished text. Plays: in, the first 2.7 s. Designed for left-aligned text. Written for text like “Build a premium, modern sports-tech / landing page for a running performance / app with a full-screen cinematic hero / and a bold white headline about speed”.

```jsonc
{
  "textAnimators": [
    { "aid": "a1", "name": "Tumble down",
      "range": {"basedOn": "charsNoSpace", "end": 12, "shape": "rampUp", "easeLow": 50},
      "effects": [{"pid": "p1", "type": "position", "x": 0, "y": -80}, {"pid": "p2", "type": "rotation", "angle": -30}, {"pid": "p3", "type": "opacity", "opacity": 0}] },
    { "aid": "a2", "name": "Lime band",
      "range": {"basedOn": "charsNoSpace", "start": 20, "end": 80, "shape": "smooth"},
      "effects": [{"pid": "p4", "type": "fill", "color": "#c4f53d"}] }
  ],
  "propertyKeyframes": {
    "txa:a1:offset": [
      { "position": 0, "value": "-12", "easing": "Sine Smooth" },  // 0 s
      { "position": 28, "value": "100", "easing": "Smooth" }  // 1.4 s
    ],
    "txa:a2:offset": [
      { "position": 22, "value": "-80", "easing": "Sine Smooth" },  // 1.1 s
      { "position": 54, "value": "80", "easing": "Smooth" }  // 2.7 s
    ]
  }
}
```

### Flap Down

Letters swing down from a hinge at their top edge under an amber band. Plays: in, the first 2.75 s. Designed for left-aligned text. Written for text like “Build a premium, modern sports-tech / landing page for a running performance / app with a full-screen cinematic hero / and a bold white headline about speed”.

```jsonc
{
  "textAnimators": [
    { "aid": "a1", "name": "Flap down",
      "range": {"basedOn": "charsNoSpace", "end": 16, "shape": "rampUp"},
      "effects": [{"pid": "p1", "type": "rotate3d", "x": 90, "y": 0, "perspective": 800}, {"pid": "p2", "type": "position", "x": 0, "y": -12}, {"pid": "p3", "type": "opacity", "opacity": 0}] },
    { "aid": "a2", "name": "Amber band",
      "range": {"basedOn": "charsNoSpace", "start": 20, "end": 80, "shape": "smooth"},
      "effects": [{"pid": "p4", "type": "fill", "color": "#ffc247"}] }
  ],
  "textAnimatorPivotY": -100,
  "propertyKeyframes": {
    "txa:a1:offset": [
      { "position": 0, "value": "-16", "easing": "Sine Smooth" },  // 0 s
      { "position": 34, "value": "100", "easing": "Smooth" }  // 1.7 s
    ],
    "txa:a2:offset": [
      { "position": 7, "value": "-80", "easing": "Sine Smooth" },  // 0.35 s
      { "position": 55, "value": "80", "easing": "Smooth" }  // 2.75 s
    ]
  }
}
```

### Drop Swell

Letters drop hard into place; a coral band lifts and swells them as it passes. Plays: in, the first 2.7 s. Designed for left-aligned text. Written for text like “Build a premium, modern sports-tech / landing page for a running performance / app with a full-screen cinematic hero / and a bold white headline about speed”.

```jsonc
{
  "textAnimators": [
    { "aid": "a1", "name": "Drop",
      "range": {"basedOn": "charsNoSpace", "end": 10, "shape": "rampUp", "easeLow": 60},
      "effects": [{"pid": "p1", "type": "position", "x": 0, "y": -120}, {"pid": "p2", "type": "opacity", "opacity": 0}] },
    { "aid": "a2", "name": "Swell band",
      "range": {"basedOn": "charsNoSpace", "start": 20, "end": 80, "shape": "smooth"},
      "effects": [{"pid": "p3", "type": "fill", "color": "#ff6b5a"}, {"pid": "p4", "type": "scale", "scale": 112}, {"pid": "p5", "type": "position", "x": 0, "y": -12}] }
  ],
  "propertyKeyframes": {
    "txa:a1:offset": [
      { "position": 0, "value": "-10", "easing": "Ease Out" },  // 0 s
      { "position": 30, "value": "100", "easing": "Smooth" }  // 1.5 s
    ],
    "txa:a2:offset": [
      { "position": 6, "value": "-80", "easing": "Sine Smooth" },  // 0.3 s
      { "position": 54, "value": "80", "easing": "Smooth" }  // 2.7 s
    ]
  }
}
```

### Rain Type

Letters fall in at random like rain while a blue band runs left to right. Plays: in, the first 2.8 s. Designed for left-aligned text. Written for text like “Build a premium, modern sports-tech / landing page for a running performance / app with a full-screen cinematic hero / and a bold white headline about speed”.

```jsonc
{
  "textAnimators": [
    { "aid": "a1", "name": "Rain",
      "range": {"basedOn": "charsNoSpace", "end": 18, "shape": "rampUp", "randomize": true, "seed": 11},
      "effects": [{"pid": "p1", "type": "position", "x": 0, "y": -70}, {"pid": "p2", "type": "opacity", "opacity": 0}] },
    { "aid": "a2", "name": "Blue band",
      "range": {"basedOn": "charsNoSpace", "start": 20, "end": 80, "shape": "smooth"},
      "effects": [{"pid": "p3", "type": "fill", "color": "#4fc3ff"}] }
  ],
  "propertyKeyframes": {
    "txa:a1:offset": [
      { "position": 0, "value": "-18", "easing": "Linear" },  // 0 s
      { "position": 36, "value": "100", "easing": "Smooth" }  // 1.8 s
    ],
    "txa:a2:offset": [
      { "position": 8, "value": "-80", "easing": "Sine Smooth" },  // 0.4 s
      { "position": 56, "value": "80", "easing": "Smooth" }  // 2.8 s
    ]
  }
}
```

### Counter Sweep

Letters type in left to right while a pink band runs back against them. Plays: in, the first 2.7 s. Designed for left-aligned text. Written for text like “Build a premium, modern sports-tech / landing page for a running performance / app with a full-screen cinematic hero / and a bold white headline about speed”.

```jsonc
{
  "textAnimators": [
    { "aid": "a1", "name": "Fade down",
      "range": {"basedOn": "charsNoSpace", "end": 12, "shape": "rampUp"},
      "effects": [{"pid": "p1", "type": "position", "x": 0, "y": -35}, {"pid": "p2", "type": "opacity", "opacity": 0}] },
    { "aid": "a2", "name": "Pink band",
      "range": {"basedOn": "charsNoSpace", "start": 20, "end": 80, "shape": "smooth"},
      "effects": [{"pid": "p3", "type": "fill", "color": "#ff5ea8"}] }
  ],
  "propertyKeyframes": {
    "txa:a1:offset": [
      { "position": 0, "value": "-12", "easing": "Sine Smooth" },  // 0 s
      { "position": 30, "value": "100", "easing": "Smooth" }  // 1.5 s
    ],
    "txa:a2:offset": [
      { "position": 14, "value": "80", "easing": "Sine Smooth" },  // 0.7 s
      { "position": 54, "value": "-80", "easing": "Smooth" }  // 2.7 s
    ]
  }
}
```

### Sunset Shrink

Big letters shrink down into place; a band paints each one top to bottom in sunset colours. Plays: in, the first 2.8 s. Designed for left-aligned text. Written for text like “Build a premium, modern sports-tech / landing page for a running performance / app with a full-screen cinematic hero / and a bold white headline about speed”.

```jsonc
{
  "textAnimators": [
    { "aid": "a1", "name": "Shrink down",
      "range": {"basedOn": "charsNoSpace", "end": 14, "shape": "rampUp"},
      "effects": [{"pid": "p1", "type": "scale", "scale": 190}, {"pid": "p2", "type": "position", "x": 0, "y": -30}, {"pid": "p3", "type": "opacity", "opacity": 0}] },
    { "aid": "a2", "name": "Sunset band",
      "range": {"basedOn": "charsNoSpace", "start": 20, "end": 80, "shape": "smooth", "easeHigh": 40},
      "effects": [{"pid": "p4", "type": "gradient", "colors": ["#ffd36b", "#ff7a45", "#e8336d"], "angle": 90, "span": "unit"}] }
  ],
  "propertyKeyframes": {
    "txa:a1:offset": [
      { "position": 0, "value": "-14", "easing": "Sine Smooth" },  // 0 s
      { "position": 32, "value": "100", "easing": "Smooth" }  // 1.6 s
    ],
    "txa:a2:offset": [
      { "position": 6, "value": "-80", "easing": "Sine Smooth" },  // 0.3 s
      { "position": 56, "value": "80", "easing": "Smooth" }  // 2.8 s
    ]
  }
}
```

### Boomerang

Letters glide down at a slant; a violet band runs out with the typing and swings back. Plays: in, the first 3 s. Designed for left-aligned text. Written for text like “Build a premium, modern sports-tech / landing page for a running performance / app with a full-screen cinematic hero / and a bold white headline about speed”.

```jsonc
{
  "textAnimators": [
    { "aid": "a1", "name": "Glide down",
      "range": {"basedOn": "charsNoSpace", "end": 16, "shape": "rampUp"},
      "effects": [{"pid": "p1", "type": "position", "x": 45, "y": -45}, {"pid": "p2", "type": "skew", "skew": -24, "axis": 0}, {"pid": "p3", "type": "opacity", "opacity": 0}] },
    { "aid": "a2", "name": "Violet band",
      "range": {"basedOn": "charsNoSpace", "start": 20, "end": 80, "shape": "smooth"},
      "effects": [{"pid": "p4", "type": "fill", "color": "#a77bff"}] }
  ],
  "propertyKeyframes": {
    "txa:a1:offset": [
      { "position": 0, "value": "-16", "easing": "Sine Smooth" },  // 0 s
      { "position": 30, "value": "100", "easing": "Smooth" }  // 1.5 s
    ],
    "txa:a2:offset": [
      { "position": 2, "value": "-80", "easing": "Sine Smooth" },  // 0.1 s
      { "position": 32, "value": "40", "easing": "Sine Smooth" },  // 1.6 s
      { "position": 60, "value": "-80", "easing": "Smooth" }  // 3 s
    ]
  }
}
```

## Depth

### Rack Focus

Words come forward out of a soft background and snap into focus; at the end they pass the focus toward you. Plays: in, the first 1.78 s on a 5-word line, then out at the end. Written for text like “Pull focus to every word”.

```json
{
  "textAnimators": [
    { "aid": "a1", "name": "Focus in",
      "range": {"basedOn": "words", "drive": "time", "animate": "in", "around": "word", "stagger": 0.12, "duration": 1.3, "curve": "Expo Out"},
      "effects": [{"pid": "p1", "type": "position", "x": 0, "y": 0, "z": -900}, {"pid": "p2", "type": "blur", "amount": 12}, {"pid": "p3", "type": "opacity", "opacity": 0}] },
    { "aid": "a2", "name": "Focus out",
      "range": {"basedOn": "words", "drive": "time", "animate": "out", "around": "word", "stagger": 0.05, "duration": 0.6, "curve": "Ease In"},
      "effects": [{"pid": "p4", "type": "position", "x": 0, "y": 0, "z": 500}, {"pid": "p5", "type": "blur", "amount": 12}, {"pid": "p6", "type": "opacity", "opacity": 0}] }
  ],
  "textAnimatorCamera": "layer",
  "textAnimatorPerspective": 1400
}
```

### Stand Up

Letters slide forward across the floor and stand up one after another, hinged at their feet; at the end they fall forward toward you. Plays: in, the first 1.5 s on a 16-letter line, then out at the end. Written for text like “Stand up and be seen”.

```json
{
  "textAnimators": [
    { "aid": "a1", "name": "Stand",
      "range": {"basedOn": "charsNoSpace", "drive": "time", "animate": "in", "around": "char", "stagger": 0.04, "duration": 0.9, "curve": "Cubic Out"},
      "effects": [{"pid": "p1", "type": "position", "x": 0, "y": 0, "z": -300}, {"pid": "p2", "type": "rotate3d", "x": 90, "y": 0, "perspective": 600}, {"pid": "p3", "type": "opacity", "opacity": 0}] },
    { "aid": "a2", "name": "Fall",
      "range": {"basedOn": "charsNoSpace", "drive": "time", "animate": "out", "around": "char", "stagger": 0.025, "duration": 0.6, "curve": "Ease In"},
      "effects": [{"pid": "p4", "type": "position", "x": 0, "y": 0, "z": 150}, {"pid": "p5", "type": "rotate3d", "x": -90, "y": 0, "perspective": 600}, {"pid": "p6", "type": "opacity", "opacity": 0}] }
  ],
  "textAnimatorPivotY": 100,
  "textAnimatorCamera": "layer",
  "textAnimatorPerspective": 600
}
```

### Strata

Words float in and rest at their own depths while a slow camera drift slides them past each other; at the end they fall back. Plays: in, the first 1.8 s on a 6-word line (Drift across the whole layer), then out at the end. Written for text like “Each word at its own depth”.

```jsonc
{
  "textAnimators": [
    { "aid": "a1", "name": "Layers",
      "range": {"basedOn": "words", "around": "word", "shape": "smooth"},
      "wiggle": {"enabled": true, "mode": "add", "min": 0, "max": 40, "rate": 0, "corr": 0, "seed": 8},
      "effects": [{"pid": "p1", "type": "position", "x": 0, "y": 0, "z": -700}] },
    { "aid": "a2", "name": "Drift",
      "range": {"basedOn": "words", "around": "word"},
      "effects": [{"pid": "p2", "type": "position", "x": 70, "y": 0, "z": -100}] },
    { "aid": "a3", "name": "Float in",
      "range": {"basedOn": "words", "drive": "time", "animate": "in", "around": "word", "stagger": 0.12, "duration": 1.2, "curve": "Cubic Out"},
      "effects": [{"pid": "p3", "type": "position", "x": 0, "y": 0, "z": -1200}, {"pid": "p4", "type": "opacity", "opacity": 0}] },
    { "aid": "a4", "name": "Fall back",
      "range": {"basedOn": "words", "drive": "time", "animate": "out", "around": "word", "order": "backward", "stagger": 0.05, "duration": 0.6, "curve": "Ease In"},
      "effects": [{"pid": "p5", "type": "position", "x": 0, "y": 0, "z": -1200}, {"pid": "p6", "type": "opacity", "opacity": 0}] }
  ],
  "textAnimatorCamera": "layer",
  "textAnimatorPerspective": 1000,
  "propertyKeyframes": {
    "txa:a2:amount": [
      { "position": 0, "value": "100", "easing": "Sine Smooth" },  // layer start
      { "position": 100, "value": "-100", "easing": "Smooth" }  // layer end
    ]
  }
}
```

### Spotlight

Words wait set back and dim; each in turn steps forward into the light, and the last one keeps it. Plays: once, the first 2.85 s on a 5-word line. Written for text like “Every word takes the stage”.

```json
{
  "textAnimators": [
    { "aid": "a1", "name": "Sit back",
      "range": {"basedOn": "words", "around": "word"},
      "effects": [{"pid": "p1", "type": "position", "x": 0, "y": 0, "z": -160}, {"pid": "p2", "type": "fill", "color": "#5d636b"}] },
    { "aid": "a2", "name": "Spotlight",
      "range": {"basedOn": "words", "drive": "time", "animate": "active", "around": "word", "delay": 0.3, "stagger": 0.55, "duration": 0.35, "hold": 0, "fadeOut": 0.3, "keepLast": true, "curve": "Cubic Out"},
      "effects": [{"pid": "p3", "type": "position", "x": 0, "y": 0, "z": 160}, {"pid": "p4", "type": "fill", "color": "#ffffff"}] }
  ],
  "textAnimatorCamera": "layer",
  "textAnimatorPerspective": 1200
}
```

### Ripple

Rings of depth spread from the centre of the text to its edges, over and over, like ripples on still water. Plays: loops for the whole layer. Written for text like “Ripples from the centre”.

```json
{
  "textAnimators": [
    { "aid": "a1", "name": "Ripple",
      "range": {"basedOn": "charsNoSpace", "drive": "time", "animate": "active", "around": "char", "order": "center", "delay": 0.2, "stagger": 0.1, "duration": 0.14, "hold": 0, "fadeOut": 0.3, "loop": true, "curve": "Sine Out"},
      "effects": [{"pid": "p1", "type": "position", "x": 0, "y": 0, "z": 110}, {"pid": "p2", "type": "fill", "color": "#8fe3ff", "mix": 65}] }
  ],
  "textAnimatorCamera": "layer",
  "textAnimatorPerspective": 1000
}
```

## Type on Shape

### Pill Type

Letters rise in a soft wave onto a pill that stretches along each line. Plays: in, the first 1.6 s. Designed for a `#0d1013` background, left-aligned. Written for text like “Type on a pill / that grows with you”.

```jsonc
{
  "textAnimators": [
    { "aid": "a1", "name": "Type",
      "range": {"basedOn": "charsNoSpace", "end": 6, "shape": "rampUp"},
      "effects": [{"pid": "p1", "type": "position", "x": 0, "y": 25}, {"pid": "p2", "type": "opacity", "opacity": 0}, {"pid": "p3", "type": "box", "color": "#33efab", "behind": "revealed", "padX": 28, "padY": 10, "radius": 60}] },
    { "aid": "a2", "name": "Ink",
      "range": {"basedOn": "charsNoSpace"},
      "effects": [{"pid": "p4", "type": "fill", "color": "#07130e"}] }
  ],
  "propertyKeyframes": {
    "txa:a1:offset": [
      { "position": 0, "value": "-6", "easing": "Linear" },  // 0 s
      { "position": 32, "value": "100", "easing": "Smooth" }  // 1.6 s
    ]
  }
}
```

### Card Type

Letters drop in while a white card widens with them, then grows a line taller. Plays: in, the first 2 s. Designed for a `#2b2f36` background, left-aligned. Written for text like “A card that grows / with every letter / you type”.

```jsonc
{
  "textAnimators": [
    { "aid": "a1", "name": "Type",
      "range": {"basedOn": "charsNoSpace", "end": 12, "shape": "rampUp"},
      "effects": [{"pid": "p1", "type": "position", "x": 0, "y": -35}, {"pid": "p2", "type": "opacity", "opacity": 0}, {"pid": "p3", "type": "box", "color": "#ffffff", "behind": "revealed", "shape": "block", "padX": 45, "padY": 30, "radius": 30}] },
    { "aid": "a2", "name": "Ink",
      "range": {"basedOn": "charsNoSpace"},
      "effects": [{"pid": "p4", "type": "fill", "color": "#16181d"}] }
  ],
  "propertyKeyframes": {
    "txa:a1:offset": [
      { "position": 0, "value": "-12", "easing": "Linear" },  // 0 s
      { "position": 40, "value": "100", "easing": "Smooth" }  // 2 s
    ]
  }
}
```

### Word Bars

Words pop up one at a time and the red bar stretches to take each one. Plays: in, the first 1.6 s. Designed for a `#101010` background, left-aligned. Written for text like “Every word lands / on its own bar”.

```jsonc
{
  "textAnimators": [
    { "aid": "a1", "name": "Words",
      "range": {"basedOn": "words", "smooth": 100},
      "effects": [{"pid": "p1", "type": "scale", "scale": 40}, {"pid": "p2", "type": "opacity", "opacity": 0}, {"pid": "p3", "type": "box", "color": "#ff3d57", "behind": "revealed", "padX": 16, "padY": 6, "radius": 6}] }
  ],
  "propertyKeyframes": {
    "txa:a1:start": [
      { "position": 0, "value": "0", "easing": "Linear" },  // 0 s
      { "position": 32, "value": "100", "easing": "Smooth" }  // 1.6 s
    ]
  }
}
```

### Word Stack

Words slide in from the left one at a time and the card grows to take each one. Plays: in, the first 1.4 s. Designed for a `#0f0d17` background, left-aligned. Written for text like “Word by word / the card grows / to fit the text”.

```jsonc
{
  "textAnimators": [
    { "aid": "a1", "name": "Words",
      "range": {"basedOn": "words", "smooth": 100},
      "effects": [{"pid": "p1", "type": "position", "x": -80, "y": 0}, {"pid": "p2", "type": "opacity", "opacity": 0}, {"pid": "p3", "type": "box", "color": "#6a3df0", "behind": "revealed", "shape": "block", "padX": 40, "padY": 22, "radius": 22}] }
  ],
  "propertyKeyframes": {
    "txa:a1:start": [
      { "position": 0, "value": "0", "easing": "Sine Smooth" },  // 0 s
      { "position": 28, "value": "100", "easing": "Smooth" }  // 1.4 s
    ]
  }
}
```

### Marker Type

Crisp letters type in one by one, a yellow marker running right at the edge. Plays: in, the first 1.8 s. Designed for a `#f4f1ea` background, left-aligned. Written for text like “A marker that keeps / up with the typing”.

```jsonc
{
  "textAnimators": [
    { "aid": "a1", "name": "Type",
      "range": {"basedOn": "charsNoSpace", "smooth": 100},
      "effects": [{"pid": "p1", "type": "opacity", "opacity": 0}, {"pid": "p2", "type": "box", "color": "#ffe14d", "behind": "revealed", "padX": 6, "padY": 2, "radius": 3}] },
    { "aid": "a2", "name": "Ink",
      "range": {"basedOn": "charsNoSpace"},
      "effects": [{"pid": "p3", "type": "fill", "color": "#141414"}] }
  ],
  "propertyKeyframes": {
    "txa:a1:start": [
      { "position": 0, "value": "0", "easing": "Linear" },  // 0 s
      { "position": 36, "value": "100", "easing": "Smooth" }  // 1.8 s
    ]
  }
}
```

### Card Erase

Letters shrink away from the end like a backspace and the card shrinks back with them. Plays: out, the last 1.4 s. Designed for a `#14161a` background, left-aligned. Written for text like “Backspace takes / the card with it”.

```jsonc
{
  "textAnimators": [
    { "aid": "a1", "name": "Erase",
      "range": {"basedOn": "charsNoSpace", "smooth": 100},
      "effects": [{"pid": "p1", "type": "scale", "scale": 50}, {"pid": "p2", "type": "opacity", "opacity": 0}, {"pid": "p3", "type": "box", "color": "#ff6a3d", "behind": "revealed", "shape": "block", "padX": 40, "padY": 25, "radius": 25}] }
  ],
  "propertyKeyframes": {
    "txa:a1:start": [
      { "position": 72, "value": "100", "easing": "Linear" },  // 1.4 s before the end
      { "position": 100, "value": "0", "easing": "Smooth" }  // the end
    ]
  }
}
```

## Emphasis

### Colour Sweep

A raised yellow band travels across the letters once. Plays: once, 0.2 s to 1.8 s. Written for text like “Every letter, one by one”.

```jsonc
{
  "textAnimators": [
    { "aid": "a1", "name": "Colour sweep",
      "range": {"basedOn": "charsNoSpace", "end": 14, "shape": "smooth"},
      "effects": [{"pid": "p1", "type": "fill", "color": "#ffd84d"}, {"pid": "p2", "type": "scale", "scale": 118}, {"pid": "p3", "type": "position", "x": 0, "y": -15}] }
  ],
  "propertyKeyframes": {
    "txa:a1:offset": [
      { "position": 4, "value": "-14", "easing": "Sine Smooth" },  // 0.2 s
      { "position": 36, "value": "100", "easing": "Smooth" }  // 1.8 s
    ]
  }
}
```

### Glow Pass

A bright glowing band passes across the text once. Plays: once, 0.2 s to 1.8 s. Written for text like “Light passes through”.

```jsonc
{
  "textAnimators": [
    { "aid": "a1", "name": "Glow pass",
      "range": {"basedOn": "charsNoSpace", "end": 26, "shape": "triangle"},
      "effects": [{"pid": "p1", "type": "fill", "color": "#f2ffff"}, {"pid": "p2", "type": "glow", "color": "#36f1ff", "size": 35, "strength": 180}] }
  ],
  "propertyKeyframes": {
    "txa:a1:offset": [
      { "position": 4, "value": "-26", "easing": "Sine Smooth" },  // 0.2 s
      { "position": 36, "value": "100", "easing": "Smooth" }  // 1.8 s
    ]
  }
}
```

### Wave Pass

A wave lifts the letters as it rolls through. Plays: once, 0.2 s to 1.7 s. Written for text like “Riding the wave”.

```jsonc
{
  "textAnimators": [
    { "aid": "a1", "name": "Wave",
      "range": {"basedOn": "charsNoSpace", "end": 30, "shape": "smooth"},
      "effects": [{"pid": "p1", "type": "position", "x": 0, "y": -55}] }
  ],
  "propertyKeyframes": {
    "txa:a1:offset": [
      { "position": 4, "value": "-30", "easing": "Sine Smooth" },  // 0.2 s
      { "position": 34, "value": "100", "easing": "Smooth" }  // 1.7 s
    ]
  }
}
```

### Pop Through

Each word swells in turn as a pulse moves through. Plays: once, 0.2 s to 2 s. Written for text like “Each word gets its moment”.

```jsonc
{
  "textAnimators": [
    { "aid": "a1", "name": "Pop",
      "range": {"basedOn": "words", "end": 40, "shape": "triangle"},
      "effects": [{"pid": "p1", "type": "scale", "scale": 135}] }
  ],
  "propertyKeyframes": {
    "txa:a1:offset": [
      { "position": 4, "value": "-40", "easing": "Sine Smooth" },  // 0.2 s
      { "position": 40, "value": "100", "easing": "Smooth" }  // 2 s
    ]
  }
}
```

### Shine

A narrow glint of light runs over the letters. Plays: once, 0.3 s to 1.4 s. Written for text like “A glint of light”.

```jsonc
{
  "textAnimators": [
    { "aid": "a1", "name": "Shine",
      "range": {"basedOn": "charsNoSpace", "end": 12, "shape": "smooth"},
      "effects": [{"pid": "p1", "type": "fill", "color": "#fffbe6"}, {"pid": "p2", "type": "glow", "color": "#fff1b8", "size": 20, "strength": 140}, {"pid": "p3", "type": "scale", "scale": 108}] }
  ],
  "propertyKeyframes": {
    "txa:a1:offset": [
      { "position": 6, "value": "-12", "easing": "Sine Smooth" },  // 0.3 s
      { "position": 28, "value": "100", "easing": "Smooth" }  // 1.4 s
    ]
  }
}
```

### Marker

A highlighter bar sweeps behind the text. Plays: once, 0.2 s to 1.2 s. Written for text like “Highlight the whole line”.

```jsonc
{
  "textAnimators": [
    { "aid": "a1", "name": "Marker",
      "range": {"basedOn": "charsNoSpace", "start": 0, "end": 0},
      "effects": [{"pid": "p1", "type": "box", "color": "#33efab", "padX": 12, "padY": 6, "radius": 14}, {"pid": "p2", "type": "fill", "color": "#07130e"}] }
  ],
  "propertyKeyframes": {
    "txa:a1:end": [
      { "position": 4, "value": "0", "easing": "Smooth" },  // 0.2 s
      { "position": 24, "value": "100", "easing": "Smooth" }  // 1.2 s
    ]
  }
}
```

### Outline Pass

Letters turn into outlines as a band passes over them. Plays: once, 0.2 s to 1.8 s. Written for text like “HOLLOW PASS”.

```jsonc
{
  "textAnimators": [
    { "aid": "a1", "name": "Outline",
      "range": {"basedOn": "charsNoSpace", "end": 35, "shape": "smooth"},
      "effects": [{"pid": "p1", "type": "stroke", "color": "#ffffff", "width": 3, "outline": true}] }
  ],
  "propertyKeyframes": {
    "txa:a1:offset": [
      { "position": 4, "value": "-35", "easing": "Sine Smooth" },  // 0.2 s
      { "position": 36, "value": "100", "easing": "Smooth" }  // 1.8 s
    ]
  }
}
```

## Loop

### Neon Flow

A glowing band loops across the text without end. Plays: loops for the whole layer. Designed for text `#56646f` on a `#07090b` background. Written for text like “NEON GLOW”.

```json
{
  "textAnimators": [
    { "aid": "a1", "name": "Neon",
      "range": {"basedOn": "charsNoSpace", "end": 26, "shape": "triangle", "flow": 36, "loop": true},
      "effects": [{"pid": "p1", "type": "fill", "color": "#f2ffff"}, {"pid": "p2", "type": "glow", "color": "#36f1ff", "size": 35, "strength": 180}] }
  ]
}
```

### Rainbow

A rainbow of colour flows through the letters. Plays: loops for the whole layer. Written for text like “Rainbow flows through”.

```json
{
  "textAnimators": [
    { "aid": "a1", "name": "Rainbow",
      "range": {"basedOn": "charsNoSpace", "shape": "rampUp", "flow": 25, "loop": true},
      "effects": [{"pid": "p1", "type": "fill", "color": "#ff5470"}, {"pid": "p2", "type": "hue", "hue": 360, "saturation": 0, "brightness": 0}] }
  ]
}
```

### Gradient Flow

A colour gradient slides through the text for the whole layer. Plays: across the whole layer. Written for text like “Gradient in motion”.

```jsonc
{
  "textAnimators": [
    { "aid": "a1", "name": "Gradient",
      "range": {"basedOn": "charsNoSpace"},
      "effects": [{"pid": "p1", "type": "gradient", "colors": ["#7cf5ff", "#b36bff", "#ff5fa2"], "angle": 0, "span": "text", "repeat": true}] }
  ],
  "propertyKeyframes": {
    "txa:a1:p1.shift": [
      { "position": 0, "value": "0", "easing": "Linear" },  // layer start
      { "position": 100, "value": "200", "easing": "Smooth" }  // layer end
    ]
  }
}
```

### Jitter

Letters shake and twitch on their own. Plays: loops for the whole layer. Written for text like “Nervous energy!”.

```json
{
  "textAnimators": [
    { "aid": "a1", "name": "Jitter",
      "range": {"basedOn": "charsNoSpace"},
      "wiggle": {"enabled": true, "rate": 7, "corr": 10},
      "effects": [{"pid": "p1", "type": "position", "x": 12, "y": 15}, {"pid": "p2", "type": "rotation", "angle": 10}] }
  ]
}
```

### Float

Letters bob slowly, as if floating on water. Plays: loops for the whole layer. Written for text like “Floating gently”.

```json
{
  "textAnimators": [
    { "aid": "a1", "name": "Float",
      "range": {"basedOn": "charsNoSpace"},
      "wiggle": {"enabled": true, "rate": 0.8, "corr": 35},
      "effects": [{"pid": "p1", "type": "position", "x": 0, "y": 18}, {"pid": "p2", "type": "rotation", "angle": 4}] }
  ]
}
```

### Flicker

Letters flicker on and off like a failing sign. Plays: loops for the whole layer. Written for text like “BROKEN SIGN”.

```json
{
  "textAnimators": [
    { "aid": "a1", "name": "Flicker",
      "range": {"basedOn": "charsNoSpace"},
      "wiggle": {"enabled": true, "rate": 9, "corr": 0, "min": 0, "max": 100},
      "effects": [{"pid": "p1", "type": "opacity", "opacity": 15}] }
  ]
}
```

### Breathing Wave

A gentle swell rolls across the text again and again. Plays: loops for the whole layer. Written for text like “Breathe in, breathe out”.

```json
{
  "textAnimators": [
    { "aid": "a1", "name": "Breathe",
      "range": {"basedOn": "charsNoSpace", "end": 40, "shape": "smooth", "flow": 30, "loop": true},
      "effects": [{"pid": "p1", "type": "scale", "scale": 120}, {"pid": "p2", "type": "position", "x": 0, "y": -10}] }
  ]
}
```

### Shimmer

A warm glint keeps running over the letters. Plays: loops for the whole layer. Written for text like “Golden shimmer”.

```json
{
  "textAnimators": [
    { "aid": "a1", "name": "Shimmer",
      "range": {"basedOn": "charsNoSpace", "end": 12, "shape": "smooth", "flow": 60, "loop": true},
      "effects": [{"pid": "p1", "type": "fill", "color": "#fff1b0"}, {"pid": "p2", "type": "glow", "color": "#ffd76a", "size": 16, "strength": 120}] }
  ]
}
```

## Characters

### Decode

Random glyphs resolve into the text, left to right. Plays: in, the first 1.6 s. Written for text like “DECRYPTING SIGNAL”.

```jsonc
{
  "textAnimators": [
    { "aid": "a1", "name": "Decode",
      "range": {"basedOn": "charsNoSpace", "smooth": 0},
      "effects": [{"pid": "p1", "type": "scramble", "charset": "alnum", "rate": 22}, {"pid": "p2", "type": "fill", "color": "#33efab"}] }
  ],
  "propertyKeyframes": {
    "txa:a1:start": [
      { "position": 0, "value": "0", "easing": "Linear" },  // 0 s
      { "position": 32, "value": "100", "easing": "Smooth" }  // 1.6 s
    ]
  }
}
```

### Binary Decode

Zeros and ones resolve into the text. Plays: in, the first 1.6 s. Written for text like “SYSTEM ONLINE”.

```jsonc
{
  "textAnimators": [
    { "aid": "a1", "name": "Binary",
      "range": {"basedOn": "charsNoSpace", "smooth": 0},
      "effects": [{"pid": "p1", "type": "scramble", "charset": "binary", "rate": 18}, {"pid": "p2", "type": "fill", "color": "#33efab"}] }
  ],
  "propertyKeyframes": {
    "txa:a1:start": [
      { "position": 0, "value": "0", "easing": "Linear" },  // 0 s
      { "position": 32, "value": "100", "easing": "Smooth" }  // 1.6 s
    ]
  }
}
```

### Alphabet Roll

Letters roll through the alphabet and stop on the text. Plays: in, the first 1.4 s. Written for text like “ROLLING LETTERS”.

```jsonc
{
  "textAnimators": [
    { "aid": "a1", "name": "Roll",
      "range": {"basedOn": "charsNoSpace"},
      "effects": [{"pid": "p1", "type": "charOffset", "offset": 12}] }
  ],
  "propertyKeyframes": {
    "txa:a1:amount": [
      { "position": 0, "value": "100", "easing": "Ease Out" },  // 0 s
      { "position": 28, "value": "0", "easing": "Smooth" }  // 1.4 s
    ]
  }
}
```

### Glitch

Random letters keep breaking into glyphs and jumping. Plays: loops for the whole layer. Written for text like “GLITCH MODE”.

```json
{
  "textAnimators": [
    { "aid": "a1", "name": "Glitch",
      "range": {"basedOn": "charsNoSpace", "end": 25, "randomize": true, "seed": 5, "flow": 40, "loop": true, "smooth": 0},
      "effects": [{"pid": "p1", "type": "scramble", "charset": "symbols", "rate": 14}, {"pid": "p2", "type": "position", "x": 8, "y": 0}, {"pid": "p3", "type": "fill", "color": "#ff3b6b", "mix": 70}] }
  ]
}
```

## Voice

### Spoken Box

A box sits under each word while it is spoken, dark text on top. Plays: while each word is spoken. Written for text like “Every word lands the moment it is spoken”.

```json
{
  "textAnimators": [
    { "aid": "a1", "name": "Spoken box",
      "range": {"basedOn": "words", "drive": "voice", "animate": "active", "duration": 0.08, "curve": "Ease Out", "fadeOut": 0.08},
      "effects": [{"pid": "p1", "type": "box", "color": "#33efab", "padX": 12, "padY": 4, "radius": 14, "grow": false}, {"pid": "p2", "type": "fill", "color": "#0b0d0c"}] }
  ]
}
```

### Spoken Pop

The spoken word swells and turns gold, then settles back. Plays: while each word is spoken. Written for text like “Every word lands the moment it is spoken”.

```json
{
  "textAnimators": [
    { "aid": "a1", "name": "Spoken",
      "range": {"basedOn": "words", "drive": "voice", "animate": "active", "duration": 0.18, "curve": "Back Out", "fadeOut": 0.2},
      "effects": [{"pid": "p1", "type": "scale", "scale": 118}, {"pid": "p2", "type": "fill", "color": "#ffd23f"}] }
  ]
}
```

### Spoken Glow

The spoken word lights up with a cool glow. Plays: while each word is spoken. Written for text like “Every word lands the moment it is spoken”.

```json
{
  "textAnimators": [
    { "aid": "a1", "name": "Glow",
      "range": {"basedOn": "words", "drive": "voice", "animate": "active", "duration": 0.1, "curve": "Linear", "fadeOut": 0.25},
      "effects": [{"pid": "p1", "type": "fill", "color": "#eafcff"}, {"pid": "p2", "type": "glow", "color": "#36f1ff", "size": 30, "strength": 160}] }
  ]
}
```

### Sung Words

Each word turns gold as it is sung and stays gold. Plays: as each word is spoken. Written for text like “Every word lands the moment it is spoken”.

```json
{
  "textAnimators": [
    { "aid": "a1", "name": "Sung",
      "range": {"basedOn": "words", "drive": "voice", "animate": "stay", "duration": 0.15, "curve": "Linear"},
      "effects": [{"pid": "p1", "type": "fill", "color": "#ffd23f"}] }
  ]
}
```

### Karaoke Wipe

Colour wipes through each word letter by letter as it is sung. Plays: as each letter is spoken. Written for text like “Every word lands the moment it is spoken”.

```json
{
  "textAnimators": [
    { "aid": "a1", "name": "Wipe",
      "range": {"basedOn": "charsNoSpace", "drive": "voice", "animate": "stay", "duration": 0.06, "curve": "Linear", "spread": true},
      "effects": [{"pid": "p1", "type": "fill", "color": "#33efab"}] }
  ]
}
```

### Read Along

Words wait dimmed and light up as they are said. Plays: as each word is spoken. Written for text like “Every word lands the moment it is spoken”.

```json
{
  "textAnimators": [
    { "aid": "a1", "name": "Not spoken yet",
      "range": {"basedOn": "words", "drive": "voice", "animate": "in", "duration": 0.2, "curve": "Ease Out"},
      "effects": [{"pid": "p1", "type": "opacity", "opacity": 30}] }
  ]
}
```

### Word Pop

Each word pops in the moment it is spoken. Plays: as each word is spoken. Written for text like “Every word lands the moment it is spoken”.

```json
{
  "textAnimators": [
    { "aid": "a1", "name": "Pop in",
      "range": {"basedOn": "words", "drive": "voice", "animate": "in", "duration": 0.35, "curve": "Back Out"},
      "effects": [{"pid": "p1", "type": "scale", "scale": 40}, {"pid": "p2", "type": "opacity", "opacity": 0}] }
  ]
}
```

### Rise on Voice

Words rise softly out of a blur as they are spoken. Plays: as each word is spoken. Written for text like “Every word lands the moment it is spoken”.

```json
{
  "textAnimators": [
    { "aid": "a1", "name": "Rise",
      "range": {"basedOn": "words", "drive": "voice", "animate": "in", "duration": 0.45, "curve": "Cubic Out"},
      "effects": [{"pid": "p1", "type": "position", "x": 0, "y": 45}, {"pid": "p2", "type": "blur", "amount": 8}, {"pid": "p3", "type": "opacity", "opacity": 0}] }
  ]
}
```

### Bounce on Voice

Words drop in and bounce as they are spoken. Plays: as each word is spoken. Written for text like “Every word lands the moment it is spoken”.

```json
{
  "textAnimators": [
    { "aid": "a1", "name": "Drop",
      "range": {"basedOn": "words", "drive": "voice", "animate": "in", "duration": 0.6, "curve": "Bounce Out"},
      "effects": [{"pid": "p1", "type": "position", "x": 0, "y": -70}, {"pid": "p2", "type": "opacity", "opacity": 0}] }
  ]
}
```

### Typed as Spoken

Letters type in at speaking pace behind a caret. Plays: as each letter is spoken. Written for text like “Every word lands the moment it is spoken”.

```json
{
  "textAnimators": [
    { "aid": "a1", "name": "Type",
      "range": {"basedOn": "charsNoSpace", "drive": "voice", "animate": "in", "duration": 0.04, "curve": "Linear", "spread": true},
      "effects": [{"pid": "p1", "type": "opacity", "opacity": 0}, {"pid": "p2", "type": "caret"}] }
  ]
}
```

<!-- PRESETS:END -->

## Classic

<!-- CLASSIC:BEGIN (generated from the app's Classic presets; do not edit by hand) -->

The editor's 29 Classic presets: calm Time-driven reveals by word or letter, highlights on their own clock, caption
bars and randomizer looks. They are in the same preset picker as the recipes above. Each JSON below is what the app
writes onto the text item when it applies the preset to a layer with a 100 px font.

They differ from the recipes above in four ways:

- **Lengths are composition px** and stay as written at any font size. The few that follow the font size are listed
  under the recipe with their formula; the JSON shows them for a 100 px font, so recompute them for the layer's font
  size in px (`textFontSize`, or in pct mode `textFontSizePct × videoSize.h / 100`).
- **No keyframes.** Every Classic recipe is Time-driven: the in side starts with the layer and the out side ends with
  it, so a recipe fits any layer length as written.
- **Layer fields.** Caption Bar and Randomizer recipes also set `textBg*` / `textBorder*` or `textRandom*` fields on
  the item (see [video-text.md](video-text.md#caption-bar-look) and [Text Randomizer](video-text.md#text-randomizer-fields)). They
  stay on the layer when you later switch recipe, so set `textBgEnabled`, `textBorderEnabled` or
  `textRandomEnabled` to `false` yourself when the new look should not have them.
- **Voice.** To time a Classic recipe to speech (an item with `textWordTimings`), set `"drive": "voice"` and
  `"spread": true` on every animator whose `animate` is not `out` or `inOut`. That is what the app's caption presets
  do when voice sync is on.

| Recipe | Category | What it does | Unit | Plays |
|---|---|---|---|---|
| [Classic Fade Up](#classic-fade-up) | Classic · Reveal | Words fade in, rising 50px | words | in and out |
| [Classic Fade Down](#classic-fade-down) | Classic · Reveal | Words drop in from above | words | in and out |
| [Classic Rise (Mask)](#classic-rise-mask) | Classic · Reveal | Words rise from behind a mask | words | in and out |
| [Classic Blur In](#classic-blur-in) | Classic · Reveal | Soft blur-focus reveal | words | in and out |
| [Classic Slide In](#classic-slide-in) | Classic · Reveal | Words slide in from the left | words | in and out |
| [Classic Side Mask](#classic-side-mask) | Classic · Reveal | Each word slides sideways out of its own box and leaves through the other side | words | in and out |
| [Classic Tilt Drop](#classic-tilt-drop) | Classic · Reveal | Words fall in tilted and straighten with a bounce | words | in and out |
| [Classic Flip Up](#classic-flip-up) | Classic · Character | Characters flip up on the X axis | letters | in and out |
| [Classic Typewriter](#classic-typewriter) | Classic · Character | Characters reveal one by one behind a blinking caret | letters | in |
| [Classic Wave Rise](#classic-wave-rise) | Classic · Character | Letters surge up in a rolling wave and settle with one soft overshoot | letters | in and out |
| [Classic Bounce Letters](#classic-bounce-letters) | Classic · Character | Letters drop from above and bounce to rest | letters | in and out |
| [Classic Materialize](#classic-materialize) | Classic · Character | Letters condense out of a cold glow, from blurred and large to sharp | letters | in and out, with a highlight |
| [Classic Neon Runner](#classic-neon-runner) | Classic · Highlight | A glow sweeps across each word | words | in, with a highlight |
| [Classic Ink Highlight](#classic-ink-highlight) | Classic · Highlight | Each word flashes a colour as it lands | words | in, with a highlight |
| [Classic Flash Type](#classic-flash-type) | Classic · Highlight | Characters reveal with a running colour flash that trails off | letters | in, with a highlight |
| [Classic Karaoke Sweep](#classic-karaoke-sweep) | Classic · Highlight | Fast type-in, then a bar walks word by word on its own clock | letters, then words | in, with a highlight |
| [Classic Chase Loop](#classic-chase-loop) | Classic · Highlight | An accent keeps chasing through the words for as long as the clip runs | words | in and out, then a looping accent |
| [Classic Sung Words](#classic-sung-words) | Classic · Highlight | Karaoke fill: each word turns gold on its beat and stays gold | words | in and out, with a highlight |
| [Classic Marker Words](#classic-marker-words) | Classic · Highlight | Words rise from a mask, then a marker stroke lands under each word and stays | words | in, with a highlight |
| [Classic Pill Grow](#classic-pill-grow) | Classic · Caption Bar | Words rise, then a dot pops at their left and stretches into a pill behind them | words | in and out |
| [Classic Lower Third](#classic-lower-third) | Classic · Caption Bar | The bar slides in behind a mask while each word slides out of its own box; exits the same way | words | in and out |
| [Classic Drop Bar](#classic-drop-bar) | Classic · Caption Bar | Bar and words drop in from above behind masks, and fall away below | words | in and out |
| [Classic Outline Tag](#classic-outline-tag) | Classic · Caption Bar | An outline draws itself open to the right while the letters slide in | letters | in and out |
| [Classic Prompt Field](#classic-prompt-field) | Classic · Caption Bar | An outlined pill fades in and the text types inside it behind a caret, like a search box | letters | in and out |
| [Classic Random Pop](#classic-random-pop) | Classic · Randomizer | Words pop in, each with a random size and accent colour | words | in and out |
| [Classic Chaos Letters](#classic-chaos-letters) | Classic · Randomizer | Characters flip in with scattered sizes and weights | letters | in and out |
| [Classic Random Rise](#classic-random-rise) | Classic · Randomizer | Masked rise; a wave of size and two colours rolls across the words | words | in and out |
| [Classic Ransom Note](#classic-ransom-note) | Classic · Randomizer | Cut-out letters: wild sizes, three colours, mixed weights and italics | letters | in |
| [Classic Editorial Typer](#classic-editorial-typer) | Classic · Randomizer | Word typing behind a caret, set in a wave of weights, sizes and italics | words | in and out |

### Classic Fade Up

Words fade in, rising 50px. App id `classic-fade-up`. Plays: in, words 0.06 s apart, 0.6 s each; out at the end, 0.5 s each. Lengths are composition px and stay as written at any font size.

```json
{
  "textAnimators": [
    { "aid": "a1", "name": "In",
      "range": {"basedOn": "words", "drive": "time", "animate": "in", "stagger": 0.06, "duration": 0.6, "curve": "Smooth", "spread": false},
      "effects": [{"pid": "p1", "type": "position", "x": 0, "y": 50}, {"pid": "p2", "type": "opacity", "opacity": 0}] },
    { "aid": "a2", "name": "Out",
      "range": {"basedOn": "words", "drive": "time", "animate": "out", "stagger": 0.06, "duration": 0.5, "curve": "Smooth", "spread": false},
      "effects": [{"pid": "p3", "type": "position", "x": 0, "y": -50}, {"pid": "p4", "type": "opacity", "opacity": 0}] }
  ]
}
```

### Classic Fade Down

Words drop in from above. App id `classic-fade-down`. Plays: in, words 0.06 s apart, 0.6 s each; out at the end, 0.5 s each. Lengths are composition px and stay as written at any font size.

```json
{
  "textAnimators": [
    { "aid": "a1", "name": "In",
      "range": {"basedOn": "words", "drive": "time", "animate": "in", "stagger": 0.06, "duration": 0.6, "curve": "Smooth", "spread": false},
      "effects": [{"pid": "p1", "type": "position", "x": 0, "y": -50}, {"pid": "p2", "type": "opacity", "opacity": 0}] },
    { "aid": "a2", "name": "Out",
      "range": {"basedOn": "words", "drive": "time", "animate": "out", "stagger": 0.06, "duration": 0.5, "curve": "Smooth", "spread": false},
      "effects": [{"pid": "p3", "type": "position", "x": 0, "y": 50}, {"pid": "p4", "type": "opacity", "opacity": 0}] }
  ]
}
```

### Classic Rise (Mask)

Words rise from behind a mask. App id `classic-rise-mask`. Plays: in, words 0.08 s apart, 0.7 s each; out at the end, 0.5 s each. Lengths are composition px and stay as written at any font size, except: In position `y` is the larger of 90 px and 1.15 × font px (115 as written, for a 100 px font); Out position `y` is −(the larger of 90 px and 1.15 × font px) (−115 as written, for a 100 px font).

```json
{
  "textAnimators": [
    { "aid": "a1", "name": "In",
      "range": {"basedOn": "words", "drive": "time", "animate": "in", "mask": true, "stagger": 0.08, "duration": 0.7, "curve": "Smooth", "spread": false},
      "effects": [{"pid": "p1", "type": "position", "x": 0, "y": 115}] },
    { "aid": "a2", "name": "Out",
      "range": {"basedOn": "words", "drive": "time", "animate": "out", "mask": true, "stagger": 0.08, "duration": 0.5, "curve": "Smooth", "spread": false},
      "effects": [{"pid": "p2", "type": "position", "x": 0, "y": -115}] }
  ]
}
```

### Classic Blur In

Soft blur-focus reveal. App id `classic-blur-in`. Plays: in, words 0.07 s apart, 0.6 s each; out at the end, 0.45 s each. Lengths are composition px and stay as written at any font size.

```json
{
  "textAnimators": [
    { "aid": "a1", "name": "In",
      "range": {"basedOn": "words", "drive": "time", "animate": "in", "stagger": 0.07, "duration": 0.6, "curve": "Smooth", "spread": false},
      "effects": [{"pid": "p1", "type": "position", "x": 0, "y": 12}, {"pid": "p2", "type": "blur", "amount": 14}, {"pid": "p3", "type": "opacity", "opacity": 0}] },
    { "aid": "a2", "name": "Out",
      "range": {"basedOn": "words", "drive": "time", "animate": "out", "stagger": 0.07, "duration": 0.45, "curve": "Smooth", "spread": false},
      "effects": [{"pid": "p4", "type": "blur", "amount": 14}, {"pid": "p5", "type": "opacity", "opacity": 0}] }
  ]
}
```

### Classic Slide In

Words slide in from the left. App id `classic-slide-in`. Plays: in, words 0.06 s apart, 0.6 s each; out at the end, 0.5 s each. Lengths are composition px and stay as written at any font size.

```json
{
  "textAnimators": [
    { "aid": "a1", "name": "In",
      "range": {"basedOn": "words", "drive": "time", "animate": "in", "stagger": 0.06, "duration": 0.6, "curve": "Smooth", "spread": false},
      "effects": [{"pid": "p1", "type": "position", "x": -60, "y": 0}, {"pid": "p2", "type": "opacity", "opacity": 0}] },
    { "aid": "a2", "name": "Out",
      "range": {"basedOn": "words", "drive": "time", "animate": "out", "stagger": 0.06, "duration": 0.5, "curve": "Smooth", "spread": false},
      "effects": [{"pid": "p3", "type": "position", "x": 60, "y": 0}, {"pid": "p4", "type": "opacity", "opacity": 0}] }
  ]
}
```

### Classic Side Mask

Each word slides sideways out of its own box and leaves through the other side. App id `classic-side-mask`. Plays: in, words 0.08 s apart, 0.7 s each; out at the end, 0.45 s each. Lengths are composition px and stay as written at any font size, except: In position `y` is 1.15 × font px (115 as written, for a 100 px font); Out position `y` is −1.15 × font px (−115 as written, for a 100 px font).

```json
{
  "textAnimators": [
    { "aid": "a1", "name": "In",
      "range": {"basedOn": "words", "drive": "time", "animate": "in", "mask": true, "stagger": 0.08, "duration": 0.7, "curve": "Expo Out", "spread": false},
      "effects": [{"pid": "p1", "type": "position", "x": -300, "y": 115}] },
    { "aid": "a2", "name": "Out",
      "range": {"basedOn": "words", "drive": "time", "animate": "out", "mask": true, "stagger": 0.08, "duration": 0.45, "curve": "Expo In", "spread": false},
      "effects": [{"pid": "p2", "type": "position", "x": 300, "y": -115}] }
  ]
}
```

### Classic Tilt Drop

Words fall in tilted and straighten with a bounce. App id `classic-tilt-drop`. Plays: in, words 0.09 s apart, 0.75 s each; out at the end, 0.4 s each. Lengths are composition px and stay as written at any font size.

```json
{
  "textAnimators": [
    { "aid": "a1", "name": "In",
      "range": {"basedOn": "words", "drive": "time", "animate": "in", "stagger": 0.09, "duration": 0.75, "curve": "Back Out", "spread": false},
      "effects": [{"pid": "p1", "type": "position", "x": 0, "y": -90}, {"pid": "p2", "type": "rotation", "angle": -14}, {"pid": "p3", "type": "opacity", "opacity": 0}] },
    { "aid": "a2", "name": "Out",
      "range": {"basedOn": "words", "drive": "time", "animate": "out", "stagger": 0.09, "duration": 0.4, "curve": "Ease In", "spread": false},
      "effects": [{"pid": "p4", "type": "position", "x": 0, "y": 60}, {"pid": "p5", "type": "rotation", "angle": 10}, {"pid": "p6", "type": "opacity", "opacity": 0}] }
  ]
}
```

### Classic Flip Up

Characters flip up on the X axis. App id `classic-flip-up`. Plays: in, letters 0.03 s apart, 0.5 s each; out at the end, 0.4 s each. Lengths are composition px and stay as written at any font size.

```json
{
  "textAnimators": [
    { "aid": "a1", "name": "In",
      "range": {"basedOn": "chars", "drive": "time", "animate": "in", "stagger": 0.03, "duration": 0.5, "curve": "Smooth", "spread": false},
      "effects": [{"pid": "p1", "type": "position", "x": 0, "y": 10}, {"pid": "p2", "type": "rotate3d", "x": 90, "y": 0}, {"pid": "p3", "type": "opacity", "opacity": 0}] },
    { "aid": "a2", "name": "Out",
      "range": {"basedOn": "chars", "drive": "time", "animate": "out", "stagger": 0.03, "duration": 0.4, "curve": "Smooth", "spread": false},
      "effects": [{"pid": "p4", "type": "rotate3d", "x": -90, "y": 0}, {"pid": "p5", "type": "opacity", "opacity": 0}] }
  ]
}
```

### Classic Typewriter

Characters reveal one by one behind a blinking caret. App id `classic-typewriter`. Plays: in, letters 0.025 s apart, 0.12 s each. Lengths are composition px and stay as written at any font size.

```json
{
  "textAnimators": [
    { "aid": "a1", "name": "In",
      "range": {"basedOn": "chars", "drive": "time", "animate": "in", "stagger": 0.025, "duration": 0.12, "curve": "Smooth", "spread": false},
      "effects": [{"pid": "p1", "type": "opacity", "opacity": 0}, {"pid": "p2", "type": "caret"}] }
  ]
}
```

### Classic Wave Rise

Letters surge up in a rolling wave and settle with one soft overshoot. App id `classic-wave-rise`. Plays: in, letters 0.03 s apart, 0.9 s each; out at the end, 0.4 s each. Lengths are composition px and stay as written at any font size.

```json
{
  "textAnimators": [
    { "aid": "a1", "name": "In",
      "range": {"basedOn": "chars", "drive": "time", "animate": "in", "stagger": 0.03, "duration": 0.9, "curve": "Smooth Overshoot", "spread": false},
      "effects": [{"pid": "p1", "type": "position", "x": 0, "y": 60}, {"pid": "p2", "type": "opacity", "opacity": 0}] },
    { "aid": "a2", "name": "Out",
      "range": {"basedOn": "chars", "drive": "time", "animate": "out", "stagger": 0.03, "duration": 0.4, "curve": "Ease In", "spread": false},
      "effects": [{"pid": "p3", "type": "position", "x": 0, "y": -40}, {"pid": "p4", "type": "opacity", "opacity": 0}] }
  ]
}
```

### Classic Bounce Letters

Letters drop from above and bounce to rest. App id `classic-bounce-letters`. Plays: in, letters 0.04 s apart, 0.9 s each; out at the end, 0.3 s each. Lengths are composition px and stay as written at any font size.

```json
{
  "textAnimators": [
    { "aid": "a1", "name": "In",
      "range": {"basedOn": "chars", "drive": "time", "animate": "in", "stagger": 0.04, "duration": 0.9, "curve": "Bounce Out", "spread": false},
      "effects": [{"pid": "p1", "type": "position", "x": 0, "y": -140}, {"pid": "p2", "type": "opacity", "opacity": 0}] },
    { "aid": "a2", "name": "Out",
      "range": {"basedOn": "chars", "drive": "time", "animate": "out", "stagger": 0.04, "duration": 0.3, "curve": "Ease In", "spread": false},
      "effects": [{"pid": "p3", "type": "position", "x": 0, "y": 40}, {"pid": "p4", "type": "opacity", "opacity": 0}] }
  ]
}
```

### Classic Materialize

Letters condense out of a cold glow, from blurred and large to sharp. App id `classic-materialize`. Plays: in, letters 0.035 s apart, 0.7 s each; out at the end, 0.4 s each; a highlight walks the letters 0.035 s apart. Lengths are composition px and stay as written at any font size.

```json
{
  "textAnimators": [
    { "aid": "a1", "name": "In",
      "range": {"basedOn": "chars", "drive": "time", "animate": "in", "stagger": 0.035, "duration": 0.7, "curve": "Cubic Out", "spread": false},
      "effects": [{"pid": "p1", "type": "scale", "scale": 135}, {"pid": "p2", "type": "blur", "amount": 18}, {"pid": "p3", "type": "opacity", "opacity": 0}] },
    { "aid": "a2", "name": "Out",
      "range": {"basedOn": "chars", "drive": "time", "animate": "out", "stagger": 0.035, "duration": 0.4, "curve": "Ease In", "spread": false},
      "effects": [{"pid": "p4", "type": "blur", "amount": 12}, {"pid": "p5", "type": "opacity", "opacity": 0}] },
    { "aid": "a3", "name": "Highlight",
      "range": {"basedOn": "chars", "drive": "time", "animate": "active", "stagger": 0.035, "duration": 0, "curve": "Linear", "fadeOut": 0.6},
      "effects": [{"pid": "p6", "type": "glow", "color": "#7ad7ff", "size": 26, "strength": 100}] }
  ]
}
```

### Classic Neon Runner

A glow sweeps across each word. App id `classic-neon-runner`. Plays: in, words 0.16 s apart, 0.35 s each; a highlight walks the words 0.16 s apart. Lengths are composition px and stay as written at any font size.

```json
{
  "textAnimators": [
    { "aid": "a1", "name": "In",
      "range": {"basedOn": "words", "drive": "time", "animate": "in", "stagger": 0.16, "duration": 0.35, "curve": "Smooth", "spread": false},
      "effects": [{"pid": "p1", "type": "opacity", "opacity": 0}] },
    { "aid": "a2", "name": "Highlight",
      "range": {"basedOn": "words", "drive": "time", "animate": "active", "stagger": 0.16, "duration": 0, "curve": "Linear"},
      "effects": [{"pid": "p2", "type": "fill", "color": "#7c5cff"}, {"pid": "p3", "type": "glow", "color": "#7c5cff", "size": 28, "strength": 100}] }
  ]
}
```

### Classic Ink Highlight

Each word flashes a colour as it lands. App id `classic-ink-highlight`. Plays: in, words 0.16 s apart, 0.35 s each; a highlight walks the words 0.16 s apart. Lengths are composition px and stay as written at any font size.

```json
{
  "textAnimators": [
    { "aid": "a1", "name": "In",
      "range": {"basedOn": "words", "drive": "time", "animate": "in", "stagger": 0.16, "duration": 0.35, "curve": "Smooth", "spread": false},
      "effects": [{"pid": "p1", "type": "position", "x": 0, "y": 14}, {"pid": "p2", "type": "opacity", "opacity": 0}] },
    { "aid": "a2", "name": "Highlight",
      "range": {"basedOn": "words", "drive": "time", "animate": "active", "stagger": 0.16, "duration": 0, "curve": "Linear"},
      "effects": [{"pid": "p3", "type": "fill", "color": "#ff5c8a"}] }
  ]
}
```

### Classic Flash Type

Characters reveal with a running colour flash that trails off. App id `classic-flash-type`. Plays: in, letters 0.05 s apart, 0.15 s each; a highlight walks the letters 0.05 s apart from 0.05 s. Lengths are composition px and stay as written at any font size.

```json
{
  "textAnimators": [
    { "aid": "a1", "name": "In",
      "range": {"basedOn": "chars", "drive": "time", "animate": "in", "stagger": 0.05, "duration": 0.15, "curve": "Smooth", "spread": false},
      "effects": [{"pid": "p1", "type": "opacity", "opacity": 0}] },
    { "aid": "a2", "name": "Highlight",
      "range": {"basedOn": "chars", "drive": "time", "animate": "active", "delay": 0.05, "stagger": 0.05, "duration": 0, "curve": "Linear", "fadeOut": 0.15},
      "effects": [{"pid": "p2", "type": "fill", "color": "#ff044b"}] }
  ]
}
```

### Classic Karaoke Sweep

Fast type-in, then a bar walks word by word on its own clock. App id `classic-karaoke-sweep`. Plays: in, letters 0.02 s apart, 0.25 s each; a highlight walks the words 0.45 s apart from 0.4 s, the last one stays lit. Lengths are composition px and stay as written at any font size, except: Highlight box `radius` is 10 px + 0.14 × font px (24 as written, for a 100 px font).

```json
{
  "textAnimators": [
    { "aid": "a1", "name": "In",
      "range": {"basedOn": "chars", "drive": "time", "animate": "in", "stagger": 0.02, "duration": 0.25, "curve": "Smooth", "spread": false},
      "effects": [{"pid": "p1", "type": "opacity", "opacity": 0}] },
    { "aid": "a2", "name": "Highlight",
      "range": {"basedOn": "words", "drive": "time", "animate": "active", "delay": 0.4, "stagger": 0.45, "duration": 0, "curve": "Linear", "fadeOut": 0.2, "keepLast": true},
      "effects": [{"pid": "p2", "type": "box", "color": "#ffe74c", "shape": "unit", "padX": 10, "padY": 10, "radius": 24, "grow": false, "withText": true}] }
  ]
}
```

### Classic Chase Loop

An accent keeps chasing through the words for as long as the clip runs. App id `classic-chase-loop`. Plays: in, words 0.03 s apart, 0.3 s each; out at the end, 0.3 s each; a highlight walks the words 0.3 s apart from 0.4 s, on a loop. Lengths are composition px and stay as written at any font size.

```json
{
  "textAnimators": [
    { "aid": "a1", "name": "In",
      "range": {"basedOn": "words", "drive": "time", "animate": "in", "stagger": 0.03, "duration": 0.3, "curve": "Smooth", "spread": false},
      "effects": [{"pid": "p1", "type": "opacity", "opacity": 0}] },
    { "aid": "a2", "name": "Out",
      "range": {"basedOn": "words", "drive": "time", "animate": "out", "stagger": 0.03, "duration": 0.3, "curve": "Smooth", "spread": false},
      "effects": [{"pid": "p2", "type": "opacity", "opacity": 0}] },
    { "aid": "a3", "name": "Highlight",
      "range": {"basedOn": "words", "drive": "time", "animate": "active", "delay": 0.4, "stagger": 0.3, "duration": 0.12, "curve": "Linear", "fadeOut": 0.35, "loop": true},
      "effects": [{"pid": "p3", "type": "fill", "color": "#33efab"}] }
  ]
}
```

### Classic Sung Words

Karaoke fill: each word turns gold on its beat and stays gold. App id `classic-sung-words`. Plays: in, words 0.04 s apart, 0.35 s each; out at the end, 0.3 s each; a highlight walks the words 0.32 s apart from 0.5 s, each stays lit. Lengths are composition px and stay as written at any font size.

```json
{
  "textAnimators": [
    { "aid": "a1", "name": "In",
      "range": {"basedOn": "words", "drive": "time", "animate": "in", "stagger": 0.04, "duration": 0.35, "curve": "Smooth", "spread": false},
      "effects": [{"pid": "p1", "type": "position", "x": 0, "y": 10}, {"pid": "p2", "type": "opacity", "opacity": 0}] },
    { "aid": "a2", "name": "Out",
      "range": {"basedOn": "words", "drive": "time", "animate": "out", "stagger": 0.04, "duration": 0.3, "curve": "Smooth", "spread": false},
      "effects": [{"pid": "p3", "type": "opacity", "opacity": 0}] },
    { "aid": "a3", "name": "Highlight",
      "range": {"basedOn": "words", "drive": "time", "animate": "active", "delay": 0.5, "stagger": 0.32, "duration": 0.15, "curve": "Linear", "hold": 10},
      "effects": [{"pid": "p4", "type": "fill", "color": "#ffd23f"}] }
  ]
}
```

### Classic Marker Words

Words rise from a mask, then a marker stroke lands under each word and stays. App id `classic-marker-lines`. Plays: in, words 0.06 s apart, 0.7 s each; a highlight walks the words 0.12 s apart from 0.9 s, each stays lit. Lengths are composition px and stay as written at any font size, except: In position `y` is the larger of 90 px and 1.15 × font px (115 as written, for a 100 px font); Highlight box `radius` is 6 px + 0.14 × font px (20 as written, for a 100 px font).

```json
{
  "textAnimators": [
    { "aid": "a1", "name": "In",
      "range": {"basedOn": "words", "drive": "time", "animate": "in", "mask": true, "stagger": 0.06, "duration": 0.7, "curve": "Expo Out", "spread": false},
      "effects": [{"pid": "p1", "type": "position", "x": 0, "y": 115}] },
    { "aid": "a2", "name": "Highlight",
      "range": {"basedOn": "words", "drive": "time", "animate": "active", "delay": 0.9, "stagger": 0.12, "duration": 0.25, "curve": "Linear", "hold": 10},
      "effects": [{"pid": "p2", "type": "box", "color": "#ff3d6e", "shape": "unit", "padX": 6, "padY": 6, "radius": 20, "grow": false, "withText": true}] }
  ]
}
```

### Classic Pill Grow

Words rise, then a dot pops at their left and stretches into a pill behind them. App id `classic-pill-grow`. Plays: in, words 0.07 s apart, 0.5 s each; out at the end, 0.25 s each. Lengths are composition px and stay as written at any font size. Sets the caption bar and its reveal (`textBg*` / `textBorder*`), as the app does when it applies the preset.

```json
{
  "textAnimators": [
    { "aid": "a1", "name": "In",
      "range": {"basedOn": "words", "drive": "time", "animate": "in", "stagger": 0.07, "duration": 0.5, "curve": "Cubic Out", "spread": false},
      "effects": [{"pid": "p1", "type": "position", "x": 0, "y": 24}, {"pid": "p2", "type": "opacity", "opacity": 0}] },
    { "aid": "a2", "name": "Out",
      "range": {"basedOn": "words", "drive": "time", "animate": "out", "stagger": 0.07, "duration": 0.25, "curve": "Ease In", "spread": false},
      "effects": [{"pid": "p3", "type": "position", "x": 0, "y": -16}, {"pid": "p4", "type": "opacity", "opacity": 0}] }
  ],
  "textBgEnabled": true, "textBgColor": "#2f6bff", "textBgPaddingX": 40, "textBgPaddingY": 20,
  "textBgRadius": 200, "textBorderEnabled": false, "textBgInType": "mask-right", "textBgInStyle": "grow",
  "textBgInDuration": 0.55, "textBgInEasing": "Expo Out", "textBgInDelay": 0.15, "textBgInGrowStart": 0,
  "textBgInGrowAppear": "scale-in", "textBgInGrowAppearDuration": 0.25, "textBgInGrowAppearEasing": "Back Out", "textBgOutType": "mask-right",
  "textBgOutStyle": "grow", "textBgOutDuration": 0.3, "textBgOutEasing": "Ease In", "textBgOutGrowStart": 0,
  "textBgOutGrowAppear": "scale-in", "textBgOutGrowAppearDuration": 0.15, "textBgOutGrowAppearEasing": "Ease In"
}
```

### Classic Lower Third

The bar slides in behind a mask while each word slides out of its own box; exits the same way. App id `classic-lower-third`. Plays: in, words 0.06 s apart, 0.7 s each; out at the end, 0.45 s each. Lengths are composition px and stay as written at any font size, except: In position `y` is 1.15 × font px (115 as written, for a 100 px font); Out position `y` is −1.15 × font px (−115 as written, for a 100 px font). Sets the caption bar and its reveal (`textBg*` / `textBorder*`), as the app does when it applies the preset.

```json
{
  "textAnimators": [
    { "aid": "a1", "name": "In",
      "range": {"basedOn": "words", "drive": "time", "animate": "in", "mask": true, "stagger": 0.06, "duration": 0.7, "curve": "Expo Out", "spread": false},
      "effects": [{"pid": "p1", "type": "position", "x": -260, "y": 115}] },
    { "aid": "a2", "name": "Out",
      "range": {"basedOn": "words", "drive": "time", "animate": "out", "mask": true, "stagger": 0.06, "duration": 0.45, "curve": "Expo In", "spread": false},
      "effects": [{"pid": "p2", "type": "position", "x": 260, "y": -115}] }
  ],
  "textBgEnabled": true, "textBgColor": "rgba(10,10,14,0.88)", "textBgPaddingX": 34, "textBgPaddingY": 18,
  "textBgRadius": 6, "textBorderEnabled": false, "textBgInType": "mask-right", "textBgInStyle": "slide",
  "textBgInDuration": 0.55, "textBgInEasing": "Expo Out", "textBgInDelay": 0, "textBgOutType": "mask-right",
  "textBgOutStyle": "slide", "textBgOutDuration": 0.45, "textBgOutEasing": "Expo In"
}
```

### Classic Drop Bar

Bar and words drop in from above behind masks, and fall away below. App id `classic-drop-bar`. Plays: in, words 0.05 s apart, 0.6 s each; out at the end, 0.4 s each. Lengths are composition px and stay as written at any font size, except: In position `y` is −(the larger of 90 px and 1.15 × font px) (−115 as written, for a 100 px font); Out position `y` is the larger of 90 px and 1.15 × font px (115 as written, for a 100 px font). Sets the caption bar and its reveal (`textBg*` / `textBorder*`), as the app does when it applies the preset.

```json
{
  "textAnimators": [
    { "aid": "a1", "name": "In",
      "range": {"basedOn": "words", "drive": "time", "animate": "in", "mask": true, "stagger": 0.05, "duration": 0.6, "curve": "Expo Out", "spread": false},
      "effects": [{"pid": "p1", "type": "position", "x": 0, "y": -115}] },
    { "aid": "a2", "name": "Out",
      "range": {"basedOn": "words", "drive": "time", "animate": "out", "mask": true, "stagger": 0.05, "duration": 0.4, "curve": "Expo In", "spread": false},
      "effects": [{"pid": "p2", "type": "position", "x": 0, "y": 115}] }
  ],
  "textBgEnabled": true, "textBgColor": "#7c5cff", "textBgPaddingX": 34, "textBgPaddingY": 16,
  "textBgRadius": 10, "textBorderEnabled": false, "textBgInType": "mask-down", "textBgInStyle": "slide",
  "textBgInDuration": 0.5, "textBgInEasing": "Expo Out", "textBgInDelay": 0, "textBgOutType": "mask-down",
  "textBgOutStyle": "slide", "textBgOutDuration": 0.4, "textBgOutEasing": "Expo In"
}
```

### Classic Outline Tag

An outline draws itself open to the right while the letters slide in. App id `classic-outline-tag`. Plays: in, letters 0.022 s apart, 0.3 s each; out at the end, 0.2 s each. Lengths are composition px and stay as written at any font size. Sets the caption bar and its reveal (`textBg*` / `textBorder*`), as the app does when it applies the preset.

```json
{
  "textAnimators": [
    { "aid": "a1", "name": "In",
      "range": {"basedOn": "chars", "drive": "time", "animate": "in", "stagger": 0.022, "duration": 0.3, "curve": "Ease Out", "spread": false},
      "effects": [{"pid": "p1", "type": "position", "x": -12, "y": 0}, {"pid": "p2", "type": "opacity", "opacity": 0}] },
    { "aid": "a2", "name": "Out",
      "range": {"basedOn": "chars", "drive": "time", "animate": "out", "stagger": 0.022, "duration": 0.2, "curve": "Ease In", "spread": false},
      "effects": [{"pid": "p3", "type": "opacity", "opacity": 0}] }
  ],
  "textBgEnabled": false, "textBgColor": "rgba(0,0,0,0.6)", "textBgPaddingX": 36, "textBgPaddingY": 18,
  "textBgRadius": 14, "textBorderEnabled": true, "textBorderColor": "#33efab", "textBorderWidth": 3,
  "textBorderStyle": "solid", "textBgInType": "mask-right", "textBgInStyle": "grow", "textBgInDuration": 0.6,
  "textBgInEasing": "Cubic Out", "textBgInDelay": 0, "textBgInGrowStart": 0, "textBgInGrowAppear": "fade",
  "textBgInGrowAppearDuration": 0.2, "textBgInGrowAppearEasing": "Ease Out", "textBgOutType": "mask-right", "textBgOutStyle": "grow",
  "textBgOutDuration": 0.4, "textBgOutEasing": "Ease In", "textBgOutGrowStart": 0, "textBgOutGrowAppear": "none",
  "textBgOutGrowAppearDuration": 0.4, "textBgOutGrowAppearEasing": "Ease In"
}
```

### Classic Prompt Field

An outlined pill fades in and the text types inside it behind a caret, like a search box. App id `classic-prompt-field`. Plays: in, letters 0.04 s apart, 0.05 s each; out at the end, 0.2 s each. Lengths are composition px and stay as written at any font size. Sets the caption bar and its reveal (`textBg*` / `textBorder*`), as the app does when it applies the preset.

```json
{
  "textAnimators": [
    { "aid": "a1", "name": "In",
      "range": {"basedOn": "chars", "drive": "time", "animate": "in", "stagger": 0.04, "duration": 0.05, "curve": "Linear", "spread": false},
      "effects": [{"pid": "p1", "type": "opacity", "opacity": 0}, {"pid": "p2", "type": "caret"}] },
    { "aid": "a2", "name": "Out",
      "range": {"basedOn": "chars", "drive": "time", "animate": "out", "stagger": 0.04, "duration": 0.2, "curve": "Ease In", "spread": false},
      "effects": [{"pid": "p3", "type": "opacity", "opacity": 0}] }
  ],
  "textBgEnabled": false, "textBgColor": "rgba(0,0,0,0.6)", "textBgPaddingX": 46, "textBgPaddingY": 28,
  "textBgRadius": 200, "textBorderEnabled": true, "textBorderColor": "rgba(255,255,255,0.5)", "textBorderWidth": 3,
  "textBorderStyle": "solid", "textBgInType": "fade", "textBgInStyle": "wipe", "textBgInDuration": 0.35,
  "textBgInEasing": "Ease Out", "textBgInDelay": 0, "textBgOutType": "fade", "textBgOutStyle": "wipe",
  "textBgOutDuration": 0.3, "textBgOutEasing": "Ease In"
}
```

### Classic Random Pop

Words pop in, each with a random size and accent colour. App id `classic-random-pop`. Plays: in, words 0.05 s apart, 0.45 s each; out at the end, 0.4 s each. Lengths are composition px and stay as written at any font size. Sets the Text Randomizer (`textRandom*`), as the app does when it applies the preset.

```json
{
  "textAnimators": [
    { "aid": "a1", "name": "In",
      "range": {"basedOn": "words", "drive": "time", "animate": "in", "stagger": 0.05, "duration": 0.45, "curve": "Back Out", "spread": false},
      "effects": [{"pid": "p1", "type": "scale", "scale": 40}, {"pid": "p2", "type": "opacity", "opacity": 0}] },
    { "aid": "a2", "name": "Out",
      "range": {"basedOn": "words", "drive": "time", "animate": "out", "stagger": 0.05, "duration": 0.4, "curve": "Smooth", "spread": false},
      "effects": [{"pid": "p3", "type": "scale", "scale": 50}, {"pid": "p4", "type": "opacity", "opacity": 0}] }
  ],
  "textRandomEnabled": true, "textRandomScope": "words", "textRandomDist": "uniform", "textRandomNth": 3,
  "textRandomSeed": 7, "textRandomSizeEnabled": true, "textRandomSizeMin": 85, "textRandomSizeMax": 150,
  "textRandomColorEnabled": true, "textRandomColors": ["#33efab"], "textRandomCoverage": 40, "textRandomWeightEnabled": true,
  "textRandomWeights": [400, 800], "textRandomItalicEnabled": false, "textRandomItalicMode": "mix", "textRandomItalicShare": 30
}
```

### Classic Chaos Letters

Characters flip in with scattered sizes and weights. App id `classic-chaos-letters`. Plays: in, letters 0.03 s apart, 0.5 s each; out at the end, 0.4 s each. Lengths are composition px and stay as written at any font size. Sets the Text Randomizer (`textRandom*`), as the app does when it applies the preset.

```json
{
  "textAnimators": [
    { "aid": "a1", "name": "In",
      "range": {"basedOn": "chars", "drive": "time", "animate": "in", "stagger": 0.03, "duration": 0.5, "curve": "Smooth", "spread": false},
      "effects": [{"pid": "p1", "type": "position", "x": 0, "y": 10}, {"pid": "p2", "type": "rotate3d", "x": 90, "y": 0}, {"pid": "p3", "type": "opacity", "opacity": 0}] },
    { "aid": "a2", "name": "Out",
      "range": {"basedOn": "chars", "drive": "time", "animate": "out", "stagger": 0.03, "duration": 0.4, "curve": "Smooth", "spread": false},
      "effects": [{"pid": "p4", "type": "rotate3d", "x": -90, "y": 0}, {"pid": "p5", "type": "opacity", "opacity": 0}] }
  ],
  "textRandomEnabled": true, "textRandomScope": "symbols", "textRandomDist": "gaussian", "textRandomNth": 3,
  "textRandomSeed": 21, "textRandomSizeEnabled": true, "textRandomSizeMin": 70, "textRandomSizeMax": 160,
  "textRandomColorEnabled": false, "textRandomColors": [], "textRandomCoverage": 35, "textRandomWeightEnabled": true,
  "textRandomWeights": [300, 700], "textRandomItalicEnabled": true, "textRandomItalicMode": "mix", "textRandomItalicShare": 25
}
```

### Classic Random Rise

Masked rise; a wave of size and two colours rolls across the words. App id `classic-random-rise`. Plays: in, words 0.08 s apart, 0.7 s each; out at the end, 0.5 s each. Lengths are composition px and stay as written at any font size, except: In position `y` is the larger of 90 px and 1.15 × font px (115 as written, for a 100 px font); Out position `y` is −(the larger of 90 px and 1.15 × font px) (−115 as written, for a 100 px font). Sets the Text Randomizer (`textRandom*`), as the app does when it applies the preset.

```json
{
  "textAnimators": [
    { "aid": "a1", "name": "In",
      "range": {"basedOn": "words", "drive": "time", "animate": "in", "mask": true, "stagger": 0.08, "duration": 0.7, "curve": "Smooth", "spread": false},
      "effects": [{"pid": "p1", "type": "position", "x": 0, "y": 115}] },
    { "aid": "a2", "name": "Out",
      "range": {"basedOn": "words", "drive": "time", "animate": "out", "mask": true, "stagger": 0.08, "duration": 0.5, "curve": "Smooth", "spread": false},
      "effects": [{"pid": "p2", "type": "position", "x": 0, "y": -115}] }
  ],
  "textRandomEnabled": true, "textRandomScope": "words", "textRandomDist": "wave", "textRandomNth": 3,
  "textRandomSeed": 12, "textRandomSizeEnabled": true, "textRandomSizeMin": 90, "textRandomSizeMax": 140,
  "textRandomColorEnabled": true, "textRandomColors": ["#7aa2ff", "#ff6b81"], "textRandomCoverage": 45, "textRandomWeightEnabled": true,
  "textRandomWeights": [500, 900], "textRandomItalicEnabled": false, "textRandomItalicMode": "mix", "textRandomItalicShare": 30
}
```

### Classic Ransom Note

Cut-out letters: wild sizes, three colours, mixed weights and italics. App id `classic-ransom-note`. Plays: in, letters 0.025 s apart, 0.4 s each. Lengths are composition px and stay as written at any font size. Sets the Text Randomizer (`textRandom*`), as the app does when it applies the preset.

```json
{
  "textAnimators": [
    { "aid": "a1", "name": "In",
      "range": {"basedOn": "chars", "drive": "time", "animate": "in", "stagger": 0.025, "duration": 0.4, "curve": "Smooth", "spread": false},
      "effects": [{"pid": "p1", "type": "scale", "scale": 30}, {"pid": "p2", "type": "rotation", "angle": 8}, {"pid": "p3", "type": "opacity", "opacity": 0}] }
  ],
  "textRandomEnabled": true, "textRandomScope": "symbols", "textRandomDist": "uniform", "textRandomNth": 3,
  "textRandomSeed": 33, "textRandomSizeEnabled": true, "textRandomSizeMin": 75, "textRandomSizeMax": 165,
  "textRandomColorEnabled": true, "textRandomColors": ["#ffd166", "#ff6b81", "#7aa2ff"], "textRandomCoverage": 60, "textRandomWeightEnabled": true,
  "textRandomWeights": [400, 700, 900], "textRandomItalicEnabled": true, "textRandomItalicMode": "mix", "textRandomItalicShare": 30
}
```

### Classic Editorial Typer

Word typing behind a caret, set in a wave of weights, sizes and italics. App id `classic-editorial-typer`. Plays: in, words 0.18 s apart, 0.14 s each; out at the end, 0.25 s each. Lengths are composition px and stay as written at any font size. Sets the Text Randomizer (`textRandom*`), as the app does when it applies the preset.

```json
{
  "textAnimators": [
    { "aid": "a1", "name": "In",
      "range": {"basedOn": "words", "drive": "time", "animate": "in", "stagger": 0.18, "duration": 0.14, "curve": "Ease Out", "spread": false},
      "effects": [{"pid": "p1", "type": "position", "x": 0, "y": 12}, {"pid": "p2", "type": "opacity", "opacity": 0}, {"pid": "p3", "type": "caret", "hide": true, "hideAfter": 1}] },
    { "aid": "a2", "name": "Out",
      "range": {"basedOn": "words", "drive": "time", "animate": "out", "stagger": 0.18, "duration": 0.25, "curve": "Ease In", "spread": false},
      "effects": [{"pid": "p4", "type": "opacity", "opacity": 0}] }
  ],
  "textRandomEnabled": true, "textRandomScope": "words", "textRandomDist": "wave", "textRandomNth": 3,
  "textRandomSeed": 5, "textRandomSizeEnabled": true, "textRandomSizeMin": 88, "textRandomSizeMax": 128,
  "textRandomColorEnabled": false, "textRandomColors": [], "textRandomCoverage": 35, "textRandomWeightEnabled": true,
  "textRandomWeights": [300, 800], "textRandomItalicEnabled": true, "textRandomItalicMode": "mix", "textRandomItalicShare": 35
}
```
<!-- CLASSIC:END -->
